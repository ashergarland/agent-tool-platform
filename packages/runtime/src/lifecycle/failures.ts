export const combineErrors = (
  primary: unknown,
  additional: readonly unknown[],
  message: string,
): unknown =>
  additional.length === 0
    ? primary
    : new AggregateError([primary, ...additional], message, { cause: primary });

export const throwCollectedErrors = (errors: readonly unknown[], message: string): void => {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
};
