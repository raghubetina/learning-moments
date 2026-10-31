// Experimental: shows the open Learning Moments question in a band above
// the prompt, with a field to answer it and a button to skip, so neither
// the question nor the answer passes through Claude's context. Off unless
// the plugin's `question_band` option is on; the Stop hook then hands
// questions to this band instead of to Claude.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandFeedback, BandQuestion } from '../types'

const question = atom({ plugin: 'learning-moments', key: 'question' } as const, null as BandQuestion | null)
const feedback = atom({ plugin: 'learning-moments', key: 'feedback' } as const, null as BandFeedback | null)
const dismissed = atom({ plugin: 'learning-moments', key: 'dismissed' } as const, null as string | null)
const status = atom({ plugin: 'learning-moments', key: 'status' } as const, null as string | null)

async function cli($: EngineInterface, args: string[]) {
  return $.process.run(['node', `${$.plugin.root}/src/cli.js`, ...args], {
    cwd: await $.session.root(),
    timeoutMs: 15000
  })
}

async function refresh($: EngineInterface) {
  const { exitCode, stdout } = await cli($, ['band', '--session', await $.session.id()])
  if (exitCode !== 0) return
  const state = JSON.parse(stdout) as { question: BandQuestion | null; feedback: BandFeedback | null }
  await update($, question, () => state.question)
  await update($, feedback, () => state.feedback)
  if (state.feedback) await update($, status, () => null)
}

export const register: Register = (on, options) => {
  if (options.question_band !== true) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const open = await read($, question)
    const shown = await read($, feedback)
    const note = await read($, status)
    const hidden = await read($, dismissed)
    const showFeedback = shown && shown.moment_id !== hidden
    if (e.props.hasSurvey || (!open && !showFeedback && !note)) return next(e)

    const table = $.ui.resolve(e)
    // A surface without a text field can't take an answer here.
    if (!('Input' in table)) return next(e)
    const { Box, Button, Input, Text } = table
    const answer = async (args: string[], message: string) => {
      if (!open) return
      await update($, status, () => message)
      await update($, question, () => null)
      const { exitCode } = await cli($, ['answer', open.moment_id, '--session', await $.session.id(), ...args])
      if (exitCode !== 0) {
        await update($, question, () => open)
        await update($, status, () => "Couldn't record that answer; try again.")
        return
      }
      if (args[0] === '--skip') return
      // The grade comes from a background process; check until it lands or
      // the grader's own timeout has surely passed.
      const poll = (attempt: number) =>
        $.clock.after(5000, () => {
          void (async () => {
            await refresh($)
            // Earlier feedback can still be showing; wait for this answer's.
            if ((await read($, feedback))?.moment_id === open.moment_id) return
            if (attempt < 12) poll(attempt + 1)
            else await update($, status, () => 'No grade yet; it will show after your next turn.')
          })()
        })
      poll(1)
    }

    if (open) {
      return (
        <Box flexDirection="column">
          <Text bold>
            Learning Moment {open.short_id}: <Text bold={false}>{open.question}</Text>
          </Text>
          <Box>
            <Input
              key="answer"
              placeholder="Your answer (Enter to submit)"
              // One argument, so an answer starting with "-" isn't read as an option.
              onSubmit={(value: string) => void answer([`--text=${value}`], 'Grading your answer…')}
            />
            <Button key="skip" label="Skip" onPress={() => void answer(['--skip'], 'Skipped.')} />
          </Box>
        </Box>
      )
    }
    if (showFeedback && shown) {
      return (
        <Box>
          <Text>
            Learning Moment {shown.short_id}: {shown.text}{' '}
          </Text>
          <Button key="dismiss" label="Dismiss" onPress={() => update($, dismissed, () => shown.moment_id)} />
        </Box>
      )
    }
    return (
      <Box>
        <Text dimColor>{note}</Text>
      </Box>
    )
  })
}
