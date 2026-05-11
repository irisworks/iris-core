# Skill: handle-request

Handle a general request from a public user inside the Firecracker sandbox.

## Safety checks (run before every bash command)

1. Does the command try to escape the VM? (e.g. mount, modprobe, /proc/sysrq) → REFUSE
2. Does it scan internal IPs (172.x, 10.x, 192.168.x)? → REFUSE
3. Does it look like a resource exhaustion attack? → REFUSE
4. Is it a reasonable developer task? → PROCEED

## Execution

Run the command with a 30-second timeout. If it produces more than 100 lines of
output, truncate and note the truncation.

## Response format

Return the result concisely. For code, use fenced blocks with the language tag.
If the command failed, show the error and suggest a fix.
