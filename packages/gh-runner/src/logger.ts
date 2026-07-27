export interface Styles {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
}

const wrap = (open: string, close: string) => (s: string) => `${open}${s}${close}`;
const plain = (s: string) => s;

export function createStyles(color: boolean): Styles {
  if (!color) {
    return { bold: plain, dim: plain, red: plain, green: plain, yellow: plain };
  }
  return {
    bold: wrap("\u001b[1m", "\u001b[0m"),
    dim: wrap("\u001b[2m", "\u001b[0m"),
    red: wrap("\u001b[31m", "\u001b[0m"),
    green: wrap("\u001b[32m", "\u001b[0m"),
    yellow: wrap("\u001b[33m", "\u001b[0m"),
  };
}

export interface Logger {
  readonly styles: Styles;
  /** A step heading, e.g. `==> Registering...` */
  say(message: string): void;
  /** Raw text, already formatted by the caller. */
  raw(message: string): void;
  /** Something the user should weigh, but which isn't fatal. */
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  /** Defaults to stderr, matching the shell original: stdout stays clean. */
  write?: (chunk: string) => void;
  /** Defaults to `stderr.isTTY`. */
  color?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((chunk: string) => void process.stderr.write(chunk));
  const styles = createStyles(options.color ?? Boolean(process.stderr.isTTY));

  return {
    styles,
    say(message) {
      write(`${styles.bold("==>")} ${message}\n`);
    },
    raw(message) {
      write(message);
    },
    warn(message) {
      write(`${styles.yellow("warning:")} ${message}\n`);
    },
    error(message) {
      write(`${styles.red("error:")} ${message}\n`);
    },
  };
}

/** A logger that swallows everything — handy in tests and library use. */
export const silentLogger: Logger = {
  styles: createStyles(false),
  say() {},
  raw() {},
  warn() {},
  error() {},
};
