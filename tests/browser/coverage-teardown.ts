import MCR from 'monocart-coverage-reports';
import { coverageEnabled, coverageOptions } from './fixtures/coverage';

// writes the browser coverage report without failing the run on coverage levels
export default async function teardown(): Promise<void>
{
  if (!coverageEnabled) return;
  const results = await MCR(coverageOptions).generate();
  if (!results) throw new Error('No browser coverage was recorded. Build with TABBLACKBOX_COVERAGE=1 first.');
}
