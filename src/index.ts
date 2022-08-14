/* eslint-disable @typescript-eslint/camelcase */

// @ts-ignore
import { debug as log, getInput, setFailed } from '@actions/core';
// @ts-ignore
import { context, getOctokit } from '@actions/github';

// Helper function to retrieve ticket number from a string (either a shorthand reference or a full URL)
const extractId = (value: string): string | null => {
  const result = value.match(/\d+/);

  if (result !== null) {
    return result[0];
  }

  return null;
};

const debug = (label: string, message: string): void => {
  log('');
  log(`[${label.toUpperCase()}]`);
  log(message);
  log('');
};

async function run(): Promise<void> {
  function getTicketPrefixAndNumbersFromMatch(matchArray: RegExpMatchArray) {
    debug('match array for linkTicket', JSON.stringify(matchArray));
    debug('match array groups for linkTicket', JSON.stringify(matchArray.groups));

    const ticketNumbers: Array<string> = (matchArray.groups?.ticketNumber || '')
      .split('-')
      .map((t: string) => t.trim());
    const ticketPrefix: string = matchArray.groups?.ticketPrefix || '';

    if (!ticketNumbers.length) {
      debug('ticketNumber not found', 'ticketNumber group not found in match array.');
    }

    if (!ticketPrefix) {
      debug('ticketPrefix not found', 'ticketPrefix group not found in match array.');
    }

    return { ticketNumbers, ticketPrefix };
  }

  function stripTile(title: string, ticketNumbers: Array<string>, ticketPrefix: string) {
    let regExp = new RegExp(`^\\[?\\s*${ticketPrefix}\\s*\\/?-?\\s*${ticketNumbers.join(', ')}\\s*\\]?\\s*`, 'gi');

    return title.replace(regExp, '');
  }

  try {
    // Provide complete context object right away if debugging
    debug('context', JSON.stringify(context));

    // Check for a ticket reference in the title
    const title: string = context?.payload?.pull_request?.title;
    const ticketLink = getInput('ticketLink', { required: false });

    // Get the title format
    const titleFormat = getInput('titleFormat', { required: true });

    // Instantiate a GitHub Client instance
    const token = getInput('token', { required: true });
    const client = getOctokit(token);
    const { owner, repo, number } = context.issue;
    const login = context.payload.pull_request?.user.login as string;
    const senderType = context.payload.pull_request?.user.type as string;
    const sender: string = senderType === 'Bot' ? login.replace('[bot]', '') : login;
    const quiet = getInput('quiet', { required: false }) === 'true';

    // Exempt Users
    const exemptUsers = getInput('exemptUsers', { required: false })
      .split(',')
      .map((user: string) => user.trim());

    // Debugging Entries
    debug('sender', sender);
    debug('sender type', senderType);
    debug('quiet mode', quiet.toString());
    debug('exempt users', exemptUsers.join(','));
    debug('ticket link', ticketLink);

    const linkTicket = async (matchArray: RegExpMatchArray): Promise<void> => {
      const { ticketNumbers, ticketPrefix } = getTicketPrefixAndNumbersFromMatch(matchArray);

      if (!ticketNumbers.length) {
        return;
      }

      if (!ticketPrefix) {
        return;
      }

      if (!ticketLink) {
        return;
      }

      if (!ticketLink.includes('%ticketNumber%')) {
        debug('invalid ticketLink', 'ticketLink must include "%ticketNumber%" variable to post ticket link.');

        return;
      }

      for (const ticketNumber of ticketNumbers) {
        const linkToTicket = ticketLink.replace('%ticketNumber%', ticketNumber).replace('%ticketPrefix%', ticketPrefix);

        const currentReviews = await client.pulls.listReviews({
          owner,
          repo,
          pull_number: number
        });

        debug('current reviews', JSON.stringify(currentReviews));

        if (
          currentReviews?.data?.length &&
          currentReviews?.data.some((review: { body?: string }) => review?.body?.includes(linkToTicket))
        ) {
          debug('already posted ticketLink', 'found an existing review that contains the ticket link');

          continue;
        }

        client.pulls.createReview({
          owner,
          repo,
          pull_number: number,
          body: `See the ticket for this pull request: ${linkToTicket}`,
          event: 'COMMENT'
        });
      }
    };

    // Check for a ticket reference in the branch
    const titleRegexBase = getInput('titleRegex', { required: true });
    const titleRegexFlags = getInput('titleRegexFlags', {
      required: true
    });
    const titleRegex = new RegExp(titleRegexBase, titleRegexFlags);
    const titleCheck = titleRegex.exec(title);

    // Return and approve if the title includes a Ticket ID
    if (titleCheck !== null) {
      debug('success', 'Title includes a ticket ID');
      await linkTicket(titleCheck);

      return;
    }

    if (sender && exemptUsers.includes(sender)) {
      debug('success', 'User is listed as exempt');

      return;
    }

    // Check for a ticket reference in the branch
    const branch: string = context.payload.pull_request?.head.ref;
    const branchRegexBase = getInput('branchRegex', { required: true });
    const branchRegexFlags = getInput('branchRegexFlags', {
      required: true
    });
    const branchRegex = new RegExp(branchRegexBase, branchRegexFlags);
    const branchCheck = branchRegex.exec(branch);

    if (branchCheck !== null) {
      debug('success', 'Branch name contains a reference to a ticket, updating title');

      const { ticketNumbers, ticketPrefix } = getTicketPrefixAndNumbersFromMatch(branchCheck);

      if (!ticketNumbers.length) {
        setFailed('Could not extract a ticketNumber reference from the branch');

        return;
      }

      if (!ticketPrefix) {
        setFailed('Could not extract a ticketPrefix reference from the branch');

        return;
      }

      const strippedTitle = stripTile(title, ticketNumbers, ticketPrefix);

      debug('title', title);
      debug('strippedTitle', strippedTitle);

      client.pulls.update({
        owner,
        repo,
        pull_number: number,
        title: titleFormat
          .replace('%ticketPrefix%', ticketPrefix)
          .replace('%ticketNumber%', ticketNumbers.join(', '))
          .replace('%title%', strippedTitle)
      });

      if (!quiet) {
        client.pulls.createReview({
          owner,
          repo,
          pull_number: number,
          body:
            "Hey! I noticed that your PR contained a reference to the ticket in the branch name but not in the title. I went ahead and updated that for you. Hope you don't mind! ☺️",
          event: 'COMMENT'
        });
      }

      await linkTicket(branchCheck);

      return;
    }

    debug('failure', 'Title, branch and body do not contain a reference to a ticket');
    setFailed('No ticket was referenced in this pull request');

    return;
  } catch (error) {
    // @ts-ignore
    setFailed(error.message);
  }
}

run();
