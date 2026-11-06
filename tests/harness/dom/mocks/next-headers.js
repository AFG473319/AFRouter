// Server-only API: give async server components something harmless outside Next.
const empty = { get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} };
export const cookies = async () => empty;
export const headers = async () => new Headers();
export const draftMode = async () => ({ isEnabled: false });
