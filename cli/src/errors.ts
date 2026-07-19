/** Error whose message is shown to the user without a stack trace. */
export class CliError extends Error {
  /** Process exit code; 2 marks usage errors, 1 everything else. */
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, 2);
}
