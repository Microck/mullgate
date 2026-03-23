# Security Policy

## Reporting a vulnerability

Do not open a public GitHub issue for a security problem.

If you find a vulnerability in Mullgate:

- email `contact@micr.dev`
- include the affected version, operating system, and a minimal reproduction
- include whether the issue exposes credentials, account numbers, or proxy traffic

You will get an acknowledgement as soon as practical. Please avoid publicly disclosing the issue until a fix or mitigation is ready.

## Scope

Security reports are especially useful for:

- credential leakage
- auth bypass
- unsafe proxy exposure defaults
- command injection
- dependency or packaging supply-chain issues

## Secrets handling

Never include real Mullvad account numbers, proxy passwords, API tokens, private keys, or full runtime config files in public issues or pull requests.
