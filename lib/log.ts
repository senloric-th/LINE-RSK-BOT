type LogLevel = "info" | "warn" | "error";

type LogContext = Record<string, string | number | boolean | undefined>;

function logToConsole(level: LogLevel, event: string, ctx?: LogContext): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  };
  const serialized = JSON.stringify(line);
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

export const log = {
  info: (event: string, ctx?: LogContext) => logToConsole("info", event, ctx),
  warn: (event: string, ctx?: LogContext) => logToConsole("warn", event, ctx),
  error: (event: string, ctx?: LogContext) => logToConsole("error", event, ctx),
};
