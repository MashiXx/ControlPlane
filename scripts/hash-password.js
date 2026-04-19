#!/usr/bin/env node
// Reads a password from stdin, prints a bcrypt hash to stdout.
// Usage:  echo -n 'mypassword' | npm run dashboard:hash --silent
//         (or run interactively and type the password + Ctrl-D)

import bcrypt from 'bcryptjs';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').trim();
  if (!password) {
    process.stderr.write('error: empty password\n');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  process.stdout.write(hash + '\n');
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
