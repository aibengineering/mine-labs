/**
 * Minecraft naming rules that are not owned by any one layer.
 *
 * Minecraft accepts a bare `zombie` or a fully-qualified `minecraft:zombie`
 * almost everywhere, but Mine Labs must not: a scenario says `zombie`, a goal
 * counts `minecraft:zombie`, and a comparison between the two silently reports
 * zero. Qualifying every id at the boundary is what makes a scenario's spelling
 * and an observation's spelling the same string. This lived as three separate
 * private copies (scenario compilation, RCON queries, inventory provisioning)
 * that had to agree without anything making them agree.
 */

/** Qualify a bare Minecraft id with the `minecraft:` namespace. */
export function resourceId(value: string): string {
  return value.includes(":") ? value : `minecraft:${value}`;
}

/**
 * Point a command at a dimension.
 *
 * Rcon has no executor, so a bare command runs in the overworld at the origin
 * and `execute in` is the only way to send it anywhere else. The overworld is
 * left bare so a scenario that never mentions a dimension compiles to exactly
 * the commands it always did. A command that is already an `execute` chain
 * gets the dimension spliced into it rather than a second `execute` in front.
 */
export function inDimension(dimension: string, command: string): string {
  if (dimension === "overworld") return command;
  const bare = command.trimStart().replace(/^\//u, "");
  const scope = `execute in ${resourceId(dimension)}`;
  return bare.startsWith("execute ") ? `${scope} ${bare.slice("execute ".length)}` : `${scope} run ${bare}`;
}

/**
 * The command as it was before `inDimension`, for reading its verb and
 * coordinates. Only the dimension scope is removed; the rest is untouched.
 */
export function withoutDimension(command: string): string {
  const bare = command.trimStart().replace(/^\//u, "");
  const scope = /^execute in \S+ (run\s+)?/u.exec(bare);
  if (!scope) return bare;
  const rest = bare.slice(scope[0].length);
  return scope[1] ? withoutDimension(rest) : `execute ${rest}`;
}

/** The verb of a command, looking through any dimension scope. */
export function commandVerb(command: string): string {
  return withoutDimension(command).split(/\s+/u)[0] ?? "";
}
