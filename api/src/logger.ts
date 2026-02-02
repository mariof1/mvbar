// Colored console logger for human-readable output

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatMessage(level: string, color: string, prefix: string, msg: string, meta?: Record<string, unknown>) {
  const ts = `${colors.gray}${timestamp()}${colors.reset}`;
  const lvl = `${color}${level.padEnd(5)}${colors.reset}`;
  const pfx = `${colors.cyan}[${prefix}]${colors.reset}`;
  const metaStr = meta ? ` ${colors.dim}${JSON.stringify(meta)}${colors.reset}` : '';
  return `${ts} ${lvl} ${pfx} ${msg}${metaStr}`;
}

export const logger = {
  info: (prefix: string, msg: string, meta?: Record<string, unknown>) => {
    console.log(formatMessage('INFO', colors.green, prefix, msg, meta));
  },
  
  warn: (prefix: string, msg: string, meta?: Record<string, unknown>) => {
    console.log(formatMessage('WARN', colors.yellow, prefix, msg, meta));
  },
  
  error: (prefix: string, msg: string, meta?: Record<string, unknown>) => {
    console.error(formatMessage('ERROR', colors.red, prefix, msg, meta));
  },
  
  debug: (prefix: string, msg: string, meta?: Record<string, unknown>) => {
    if (process.env.DEBUG) {
      console.log(formatMessage('DEBUG', colors.gray, prefix, msg, meta));
    }
  },
  
  success: (prefix: string, msg: string, meta?: Record<string, unknown>) => {
    console.log(formatMessage('✓', colors.green + colors.bright, prefix, msg, meta));
  },
  
  progress: (prefix: string, msg: string, current: number, total: number) => {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
    console.log(formatMessage('PROG', colors.blue, prefix, `${msg} ${colors.cyan}${bar}${colors.reset} ${pct}% (${current}/${total})`));
  },
};

export default logger;
