# Records the README demo GIF with VHS (https://github.com/charmbracelet/vhs): `vhs docs/demo/failure-demo.tape`
# Needs the Next.js target running (`chaos/targets/nextjs.sh up`) and a populated .env.
Output docs/demo/failure-demo.gif
Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set TypingSpeed 40ms

Type "# 1) the same event delivered three times -> one effect" Enter
Type "chaos/resend-twice.sh" Enter
Sleep 25s
Type "# 2) a tampered payload -> 400, nothing processed" Enter
Type "chaos/tamper.sh" Enter
Sleep 20s
Type "# 3) the customer pays while the listener is down -> reconcile restores access" Enter
Type "chaos/drop-webhooks.sh" Enter
Sleep 45s
