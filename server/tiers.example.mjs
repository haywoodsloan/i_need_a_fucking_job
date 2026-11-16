// A starting point for your own fetch tiers.
//
// Copy this file to server/tiers.local.mjs (that name is gitignored), fill it in, and turn it on in server/.env:
//   FETCH_TIERS_MODULE=./tiers.local.mjs
//
// Your tiers run after the built-in ones (cache, http, and the browser tier when it is on), in the order listed
// here, and only for requests those could not answer. docs/fetch-tiers.md describes the contract.

/** @type {import('./src/fetcher').FetchTier[]} */
export const tiers = [
  {
    name: 'example',
    async fetch({ url, init, failures }) {
      // url, init    the request, exactly as the job source made it
      // failures     what each earlier tier reported, in order: { tier, error, blocked }
      //
      // Return a Response to answer the request (a successful one is cached like any other),
      // return undefined to pass it on, or throw to record a failure and pass it on.
      return undefined;
    },
  },
];
