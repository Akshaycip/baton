// Sample notices a validator might send to its current delegators. In production a validator
// would post these itself, signing with its pool owner account.

const SHARED = [
  {
    title: 'Planned maintenance',
    body: 'We are moving to new hardware on Thursday at 14:00 UTC. Expect about five minutes of missed blocks. Your stake is not affected.',
  },
  {
    title: 'Commission',
    body: 'Our commission stays where it is for the next 90 days. We will post here at least 7 days before any change.',
  },
];

export const notesFor = (pool) => {
  const name = pool.split('.')[0];
  return SHARED.map((note) => ({ ...note, from: `${name} operators`, sample: true }));
};
