# AppleScript (macOS automation)

Instrument each script to emit handler-level start/end events via the `superlog-log` helper binary. The helper appends to `~/Library/Logs/Superlog/scripts.ndjson`; a Collector tails that file and ships to Superlog.

Scope:
- Find every `.applescript` (text source), `.scpt` (compiled), and `.scptd` (bundle, contains a compiled script at `Contents/Resources/Scripts/main.scpt`) under the project root using Glob.
- Skip anything under `node_modules`, `.git`, or paths the project explicitly excludes.

Helper path resolution — run `brew --prefix` ONCE at the start and use `<prefix>/bin/superlog-log` as the absolute path in every injected `do shell script`. The PATH available inside `do shell script` is minimal; always use the absolute path. If `brew` is not installed, default to `/usr/local/bin/superlog-log` and note it in your report.

Editing workflow per file:
- `.applescript` (text): edit in place.
- `.scpt` (compiled): copy the original to `<file>.pre-superlog` first. Then `osadecompile <file> > /tmp/sl-<basename>.applescript`, apply the transformation to that text, then `osacompile -o <file> /tmp/sl-<basename>.applescript`. If `osacompile` fails, restore from `.pre-superlog` and mark the file as failed.
- `.scptd` (bundle): treat `<bundle>/Contents/Resources/Scripts/main.scpt` as a `.scpt` file.

Terminator subroutine — inject this block ONCE per file, at the very top (before any handlers). Replace `<HELPER>` with the resolved absolute helper path:

  on _slEnd(returnValue, runId, handlerName)
    try
      do shell script "<HELPER> event " & quoted form of ("{\"e\":\"end\",\"s\":\"" & handlerName & "\",\"r\":\"" & runId & "\",\"status\":\"ok\"}")
    end try
    return returnValue
  end _slEnd

Transformation per handler. For each `on <name>(<params>) ... end <name>` block (including implicit top-level for scripts without handlers — wrap the whole body), rewrite the body like this:

  on <name>(<params>)
    set _slRun to do shell script "uuidgen"
    try
      do shell script "<HELPER> event " & quoted form of ("{\"e\":\"start\",\"s\":\"<name>\",\"r\":\"" & _slRun & "\"}")
    end try
    try
      <original body, with EVERY `return <expr>` rewritten to `return my _slEnd(<expr>, _slRun, "<name>")`>
      my _slEnd(missing value, _slRun, "<name>")
    on error errMsg number errNum
      try
        do shell script "<HELPER> event " & quoted form of ("{\"e\":\"end\",\"s\":\"<name>\",\"r\":\"" & _slRun & "\",\"status\":\"error\",\"code\":" & errNum & "}")
      end try
      error errMsg number errNum
    end try
  end <name>

Why this pattern: placing end-ok after the original body is dead code when the body contains a `return` statement — the handler exits before the log call is reached. The terminator subroutine intercepts every return path: `return my _slEnd(val, ...)` logs end-ok then passes `val` through unchanged; the trailing `my _slEnd(missing value, ...)` fires only when the body falls off the end with no explicit return. Either way exactly one end event is emitted per invocation.

Return rewrite rules:
- Rewrite `return someValue` → `return my _slEnd(someValue, _slRun, "<name>")`
- Rewrite `return` (bare, no value) → `return my _slEnd(missing value, _slRun, "<name>")`
- The `my` keyword is required — it disambiguates a subroutine call from a property access inside a handler.
- Do NOT rewrite `return` statements that are inside nested handlers within the same file — only rewrite returns that belong to the handler currently being instrumented.

Critical invariants (do NOT relax):
- Every helper call (including inside `_slEnd`) is wrapped in its own inner `try`. Logging failure must never break the host script.
- The outer error handler ALWAYS re-raises with `error errMsg number errNum`. Never swallow. Re-raise preserves the script's exit behavior exactly — the whole point of this instrumentation approach.
- Do not include the error message string in the JSON payload: AppleScript errors can contain quotes/newlines that are a pain to escape safely in shell. Pass only the numeric code.
- Do not add `display dialog`, `say`, or any UI side effects.

Smoketest after each edit:
- Text scripts: `osacompile -o /tmp/sl-smoke.scpt <edited-file>`. Nonzero exit = your edit broke syntax. Revert the file.
- Compiled scripts: the `osacompile -o <original> ...` step IS the smoketest; the `.pre-superlog` backup is your recovery path on failure.

Handler discovery hints:
- Folder Actions enter via `on adding folder items to this_folder after receiving these_items` and friends — instrument each such handler found in the file.
- Mail rules enter via `on perform mail action with messages theMessages for rule theRule`.
- Many scripts have no explicit handler and are entirely top-level. Wrap the top-level body as if it were a single implicit handler named after the file (e.g., a file `sync-inbox.applescript` gets `s: "sync-inbox"`).

Do not run the scripts. Many of these scripts are wired into live workflows (Mail, Folder Actions) — invoking them out of context will trigger real side effects. Compilation smoketest is the only local verification you perform.

Service name for the report: use the basename of the project directory. Signals: `["logs"]` (we ingest handler events as logs for now; spans can be derived downstream).
