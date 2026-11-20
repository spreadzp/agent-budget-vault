export const COMMANDS = ["provision", "sweep", "e2e", "resume", "status", "neg", "abandon"] as const;
export type Command = (typeof COMMANDS)[number];

export function parseCommand(argv: string[]): { cmd: Command; args: string[] } {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error(`usage: peach-e2e <${COMMANDS.join("|")}> [args]`);
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error(`unknown command: ${cmd} (expected: ${COMMANDS.join(" | ")})`);
  }
  return { cmd: cmd as Command, args };
}
