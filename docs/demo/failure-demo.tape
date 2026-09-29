# Records the README demo GIF with VHS (https://github.com/charmbracelet/vhs), from the repository root:
#   chaos/targets/nextjs.sh up
#   env -i HOME="$HOME" USER="$USER" SHELL=/bin/bash TERM=xterm-256color PATH="$PATH" vhs docs/demo/failure-demo.tape
# (a minimal environment keeps the Stripe CLI from printing agent-detection hint lines into the recording)
# Runs three scenarios LIVE against Stripe test mode (needs a populated .env). Each step waits for the
# scenario's real verdict instead of a fixed delay.
Output docs/demo/failure-demo.gif
Set Shell "bash"
Set FontSize 15
Set Width 1400
Set Height 760
Set Padding 20
Set TypingSpeed 35ms
Set Theme "Dracula"

Type "# 1) the same Stripe event delivered 3 times -> exactly one effect" Enter
Sleep 800ms
Type "chaos/resend-twice.sh" Enter
Wait+Screen@120s /-> duplicate: pass/
Sleep 3s

Type "clear" Enter
Type "# 2) a tampered payload -> 400, nothing processed" Enter
Sleep 800ms
Type "chaos/tamper.sh" Enter
Wait+Screen@120s /-> tamper: pass/
Sleep 3s

Type "clear" Enter
Type "# 3) the customer pays while webhooks are down -> reconcile restores access" Enter
Sleep 800ms
Type "chaos/drop-webhooks.sh" Enter
Wait+Screen@240s /-> missed-webhook: pass/
Sleep 4s
