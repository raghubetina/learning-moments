// The question band's state, shared between its hooks within a session.
export type BandQuestion = { moment_id: string; short_id: string; question: string };
export type BandFeedback = { moment_id: string; short_id: string; label?: string; text: string };

declare module 'claude-code' {
  interface PluginState {
    'learning-moments': {
      question: BandQuestion | null;
      feedback: BandFeedback | null;
      dismissed: string | null;
      status: string | null;
    };
  }
}
