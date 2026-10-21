import type { Archive } from '../../src/archive';
import type { Repository } from '../../src/database';

export async function exportArchive(repository: Repository, id?: string): Promise<Archive>
{
  const archive: Archive = { format: 'tabblackbox', version: 1, sessions: [] };
  await repository.exportSaved(session => { archive.sessions.push(session); }, id);
  return archive;
}
