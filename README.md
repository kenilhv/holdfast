# CoSign

Holds a vendor payment until the payee proves who it is. Built at Night Hack, October 30, 2026.

Send it a vendor email or invoice, on the board or over iMessage. It reads the bill, checks the sender, fetches the vendor's real site, scores the risk, and signs the record. On a hold, a person approves or rejects by text.

## How it decides

Plain code decides. Claude reads documents and web pages, and the only points it adds directly are the 10 for urgent wording. A blank field cannot clear a bill: a missing sender holds it, a photo or PDF never proves its sender, and bank-change wording is also searched for in the raw text.

| Signal | Points |
|---|---|
| Lookalike sender | 60 |
| Unknown vendor | 50 |
| Bank changed | 40 |
| New domain | 40 |
| Phone mismatch | 40 |
| Sender not on file, not shown, or not proven | 40 |
| Reply-To differs | 30 |
| Urgent wording | 10 |

0 to 39 is PASS, 40 to 79 is HOLD, 80 or more is BLOCK. A web claim is accepted only if its URL was fetched in that run and its quote is on that page.

## Run it

```bash
npm ci
cp .env.example .env
npm start
```

`npm test` runs the tests. `npm run eval` runs the rules against 22 bills the team wrote.

## Limits

The board is public. Anyone can run a limited number of checks and reject a bill, but approving or overriding takes the operator key. Records and the hash chain live in memory and in a temporary file, so they last for one boot on Render's free tier. The signing key does survive restarts. The vendor list, its bank digits and the demo bills are made up for the demo.

## What came from where

The first commit holds two files reused from Bill Passport: the hash chain and the signing code. Everything after it is sprint work.
