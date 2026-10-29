# Reporting an issue or an idea

Thank you for taking the time. Good reports make Steward better for everyone.

**Security problems never go into a public issue** – see [SECURITY.md](SECURITY.md) for the private way.

## Before you open one

- Check that you run the latest release (_About Steward_ shows the version) and whether the problem is already known in
  the [open issues](https://github.com/vxrz/Steward/issues).
- For a question about how to do something, the [docs](docs/) and the README often answer it faster.

## Open an issue

Choose **[New issue](https://github.com/vxrz/Steward/issues/new/choose)**: _Bug report_ for something that does not
work as described, _Feature or improvement_ for an idea. The forms ask for what helps:

| What                     | Why                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Steward version          | _About Steward_ – the web UI and the server show their version and build                 |
| How you run it           | Docker, desktop executable or Node.js; SQLite or PostgreSQL; behind a path prefix or not |
| Steps to reproduce       | Short, numbered; the smallest example that shows it                                      |
| Expected and actual      | What should have happened, what happened instead                                         |
| Screenshots              | Light or dark, desktop or phone – whatever shows it                                      |
| Status and error details | _Settings → System status_, the run's protocol, the error code shown in the message      |

A process or monitor that misbehaves is easiest to look at as YAML: _Export YAML_ in the editor – with your own names
replaced if needed.

## Never include

- **Credentials of any kind**: passwords, tokens, API keys, client secrets, the vault passphrase, cookies, signed URLs.
- **Personal data**: names, e-mail addresses and user ids of real people (use `alice`, `bob`), screenshots of user lists.
- **Internal details**: host names, IP addresses, tenant names, customer names, internal URLs – replace them with
  `example.com`, `10.0.0.1`, `tenant-a`.
- Full logs or database files. Copy the few relevant lines and check them for the points above.

Issues are public. When in doubt, leave it out – we will ask if something is missing.
