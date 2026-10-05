/**
 * Pure launcher rendering for a per-user, no-sudo Desktop Entry installation.
 *
 * Nothing in this module touches the file system, the network or any external
 * process: it only turns three absolute paths into two launcher strings.
 */

/** Characters that no POSIX shell word or Desktop Entry value may contain. */
const FORBIDDEN_CHARS = ['\0', '\r', '\n'];

function requireString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  if (FORBIDDEN_CHARS.some(character => value.includes(character))) {
    throw new Error(`${label} must not contain NUL, CR or LF`);
  }
  return value;
}

/**
 * Quote one argument for POSIX /bin/sh.
 *
 * The argument is wrapped in single quotes and every embedded single quote is
 * closed, escaped and reopened (`'\''`). Inside single quotes dash treats every
 * byte literally, so `$`, backticks, backslashes, `;`, globs and whitespace can
 * never be expanded. An empty argument becomes the two-character word `''`.
 */
export function shellQuote(value) {
  requireString(value, 'shellQuote value');
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Apply the general Desktop Entry string-value escaping to a value.
 *
 * The value layer removes one level of backslash escapes before the Exec
 * argument layer ever sees the text, so a literal backslash must survive as
 * `\\` and a space/tab as `\s`/`\t`.
 */
function escapeValue(value) {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === ' ') out += '\\s';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}

/**
 * Encode one argument for the `Exec` key of a Desktop Entry file.
 *
 * Two specification layers are applied:
 *
 *  1. Exec quoting: the argument is enclosed in double quotes and `"`, `` ` ``,
 *     `$` and `\` are backslash escaped inside those quotes.
 *  2. String-value escaping: the already quoted token is passed through
 *     {@link escapeValue}, which doubles every backslash and turns spaces and
 *     tabs into `\s` and `\t`.
 *
 * Because of layer 2 a literal `$` becomes `\\$` and a literal backslash becomes
 * `\\\\` in the file, which is exactly what the two-stage parser needs. Every
 * literal `%` is doubled so a path can never inject a field code.
 */
export function desktopExecQuote(value) {
  requireString(value, 'desktopExecQuote value');
  let inner = '';
  for (const ch of value) {
    if (ch === '"' || ch === '`' || ch === '$' || ch === '\\') {
      inner += `\\${ch}`;
    } else {
      inner += ch;
    }
  }
  return escapeValue(`"${inner}"`).replaceAll('%', '%%');
}

function requireAbsolutePath(value, label) {
  requireString(value, label);
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (!value.startsWith('/')) {
    throw new Error(`${label} must be an absolute POSIX path`);
  }
  return value;
}

/**
 * Build the pairs of launcher contents for one user.
 *
 * The shell wrapper resolves its target through the fixed `/usr/bin/readlink`
 * *at launch time*, then execs the concrete resolved release path. Resolving
 * once up front is what keeps a running process pinned to the release it
 * started from: `home/.local/opt/yeyu/active/current/yeyu` may be repointed at
 * another release later, but the already-resolved path does not change.
 *
 * The Desktop Entry cannot exec that wrapper path directly whenever the path
 * contains a literal `%`: Gio validates the Exec `argv[0]` before it expands
 * field codes, so even the spec-correct `%%` encoding fails to load. The entry
 * therefore uses the fixed `/bin/sh` as `argv[0]` and passes the wrapper path
 * as an ordinary quoted argument. That avoids the Gio limitation without
 * `sh -c` or `eval`, and lets `home`/`executable` contain `=`.
 *
 * @param {{home: string, executable: string, icon: string}} paths
 * @returns {{shell: string, desktop: string}} both newline terminated
 */
export function createUserLaunchers({ home, executable, icon } = {}) {
  requireAbsolutePath(home, 'home');
  requireAbsolutePath(executable, 'executable');
  requireAbsolutePath(icon, 'icon');

  const profile = `${home}/.config/页语`;
  const wrapper = `${home}/.local/bin/yeyu`;

  const shell = [
    '#!/bin/sh',
    // Resolve the mutable `current` symlink first, then pin the concrete
    // release path for the lifetime of this process.
    `resolved=$(/usr/bin/readlink -f -- ${shellQuote(executable)})`,
    'if [ "$?" -ne 0 ] || [ -z "$resolved" ]; then',
    "  echo 'yeyu: cannot resolve launcher executable' >&2",
    '  exit 1',
    'fi',
    'if [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then',
    "  echo 'yeyu: launcher executable is not an executable regular file' >&2",
    '  exit 1',
    'fi',
    `exec "$resolved" --user-data-dir=${shellQuote(profile)} --ozone-platform=x11 --disable-gpu "$@"`,
    '',
  ].join('\n');

  const desktop = [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=页语',
    'StartupWMClass=yeyu',
    `Icon=${escapeValue(icon)}`,
    'Categories=Education;',
    'Terminal=false',
    // Gio parses the Exec `argv[0]` before expanding field codes; a direct
    // executable path containing `%` cannot load, not even as `%%`. Launch the
    // fixed wrapper through `/bin/sh` instead (no `-c`, no `eval`).
    `Exec=/bin/sh ${desktopExecQuote(wrapper)} %U`,
    '',
  ].join('\n');

  return { shell, desktop };
}
