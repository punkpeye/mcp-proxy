export const prefixLines = (inputString: string, prefix: string): string => {
  return inputString.replaceAll(/^/gmu, prefix);
};
