# Contributing to Stellar

Thanks for taking an interest. This page covers the two things you need before
opening a pull request: the licensing terms, and how to run the checks.

## Licensing

Stellar is licensed under **GPL-3.0-or-later** (see `LICENSE`). Anyone may use,
study, modify and redistribute it; anyone who distributes a modified version
must ship the source under the same licence.

Before your first pull request is merged, you need to accept the
[Contributor License Agreement](CLA.md). You keep the copyright on what you
write — the agreement grants the project the right to relicense Stellar in the
future, which the GPL alone would not allow once third-party code is in the
tree. Accept it by adding this line to your pull request description:

```
I have read CLA.md and I accept it. Signed: <your full name> <your email>
```

One acceptance covers everything you contribute afterwards.

## Getting set up

```bash
npm install
npm run dev          # Electron in development
```

## Before you open a pull request

```bash
npm run lint
npm run format:check
npm run check:types:test
npm run test:unit
npm run verify:ci
```

`npm run verify` also runs the smoke suite, which needs a display. In a headless
environment it will fail for reasons unrelated to your change — run it locally
instead.

## Pull requests

- One concern per pull request. A change that fixes a bug and refactors around
  it is two pull requests.
- Describe what breaks if the change is wrong, not just what it does.
- Match the surrounding code. Stellar has established patterns for cards,
  connectors and IPC; follow the ones next to the code you are touching rather
  than introducing a new style.
- New behaviour comes with a test. If it genuinely cannot be tested, say why in
  the pull request.

## Reporting bugs

Open an issue with the Stellar version, your operating system, what you did,
what you expected and what happened. A console log from the failing card is
worth more than a description of it.

## Security

Do not open a public issue for a security problem. Email
lucassabino.rj@gmail.com with the details and give it a reasonable window before
disclosing publicly.
