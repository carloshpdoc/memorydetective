# memorydetective hero demo
# Generates examples/demo.gif. Regenerate locally with: vhs examples/demo.tape
#
# Shows the user-facing outcome: a real .memgraph in, a structured diagnosis
# and a high-confidence fix hint out. The Hide/Show blocks skip the ~25s
# `leaks(1)` subprocess wait so the GIF stays short.
#
# Prerequisites for regeneration:
#   - `memorydetective` is installed globally (`npm install -g memorydetective`).
#   - A `.memgraph` exists at $MEMGRAPH (defaults to ~/Desktop/example-leaks.memgraph).

Output examples/demo.gif

Set Shell "bash"
Set FontSize 13
Set Width 1100
Set Height 720
Set Theme "Catppuccin Mocha"
Set Padding 20
Set TypingSpeed 35ms

# Use a clean PATH that includes nvm-managed npm globals + the standard macOS
# locations. Avoids `command not found` for memorydetective when vhs's
# sandbox doesn't inherit the user's full PATH.
Env PATH "/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
Env PS1 "$ "

# Quick prelude: confirm the binary is on PATH and the input file exists.
Hide
Type "clear"
Enter
Show
Sleep 500ms

Type "memorydetective --version"
Enter
Sleep 1500ms

Type "ls ~/Desktop/example-leaks.memgraph"
Enter
Sleep 1s

# Run analyze. Hide the ~25s `leaks(1)` subprocess so the GIF stays short.
Type "memorydetective analyze ~/Desktop/example-leaks.memgraph"
Enter
Hide
Sleep 28s
Show
Sleep 4s

# Classify the cycles.
Type "memorydetective classify ~/Desktop/example-leaks.memgraph"
Enter
Hide
Sleep 28s
Show
Sleep 5s
