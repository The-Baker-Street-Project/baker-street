export const MEMORY_CONFIG = {
  /** Max recent messages to keep in the prompt tail */
  keepLastMessages: 12,
  /** Unobserved message tokens before triggering observer */
  observeThresholdTokens: 30_000,
  /** Observation log tokens before triggering reflector */
  reflectThresholdTokens: 40_000,
  /** Minimum minutes between reflector runs */
  reflectMinIntervalMinutes: 60,
};
