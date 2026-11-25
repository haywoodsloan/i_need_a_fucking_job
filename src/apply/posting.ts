/**
 * From a job in the search results to an application to track: the facts of the posting as the search gave them,
 * copied and not reworded. No `node:` imports and no DOM here, like the rest of this folder.
 */
import type { JobPosting, Salary } from '../jobs/types';
import { LIMITS, postingKey, type ApplicationSummary, type TrackedJob, type TrackedListing } from './model';

/** An address the tracker takes: http or https, with no name and password in it. */
function webAddress(address: string | undefined): string | undefined {
  try {
    const url = new URL(address ?? '');
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && url.href.length <= LIMITS.address ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const oneLine = (text: string | undefined) => text?.trim().slice(0, LIMITS.line).trim() || undefined;

function money(amount: number, currency: string | undefined): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount);
  } catch {
    // A currency code the browser does not know.
    return `${amount.toLocaleString('en-US')} ${currency}`;
  }
}

/** The pay in words: the posting's own when it gave them, and otherwise its numbers written out. */
export function payText(salary: Salary | undefined): string | undefined {
  if (!salary) return undefined;
  const said = oneLine(salary.text);
  if (said) return said;
  const { min, max } = salary;
  if (!min && !max) return undefined;
  const range = min && max && min !== max ? `${money(min, salary.currency)} to ${money(max, salary.currency)}` : money((min || max)!, salary.currency);
  return `${range}${salary.period ? ` ${salary.period === 'hour' ? 'an' : 'a'} ${salary.period}` : ''}`;
}

/** Where a job was found, as the tracker keeps it. A listing whose address is no web address is kept by name. */
function listings(job: JobPosting): TrackedListing[] {
  return job.listings.slice(0, LIMITS.listings).flatMap((l) => {
    const via = oneLine(l.via);
    const url = webAddress(l.url);
    return via ? [url ? { via, url } : { via }] : [];
  });
}

/** The address the posting itself is at: the first place it was found that has a usable one. */
export const postingAddress = (job: JobPosting): string | undefined => job.listings.map((l) => webAddress(l.url)).find((url) => url !== undefined);

/**
 * What to send to the tracker to save this job. Undefined when the job has no title, no company or no usable
 * address, which the tracker needs.
 */
export function applicationFor(job: JobPosting): { job: TrackedJob } | undefined {
  const title = oneLine(job.title);
  const company = oneLine(job.company);
  const postingUrl = postingAddress(job);
  if (!title || !company || !postingUrl) return undefined;
  const posted = job.postedAt?.trim();
  const tracked: TrackedJob = { title, company, postingUrl, listings: listings(job) };
  const location = oneLine(job.location);
  if (location) tracked.location = location;
  if (job.workplace) tracked.workplace = job.workplace;
  const pay = payText(job.salary);
  if (pay) tracked.pay = pay;
  if (posted && posted.length <= 40 && !Number.isNaN(Date.parse(posted))) tracked.postedAt = posted;
  // A description longer than the tracker takes is left out whole: half a posting would read as the whole one.
  if (job.descriptionHtml && job.descriptionHtml.length <= LIMITS.description) tracked.descriptionHtml = job.descriptionHtml;
  if (job.descriptionText && job.descriptionText.length <= LIMITS.description) tracked.descriptionText = job.descriptionText;
  return { job: tracked };
}

/** The tracked application for this job, when there is one: any place the job is listed is the tracked posting. */
export function trackedAs(job: JobPosting, applications: readonly ApplicationSummary[]): ApplicationSummary | undefined {
  const keys = new Set(job.listings.flatMap((l) => (webAddress(l.url) ? [postingKey(l.url)] : [])));
  return applications.find((a) => keys.has(postingKey(a.postingUrl)));
}
