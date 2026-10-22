import MCR from 'monocart-coverage-reports';
import { coverageEnabled, coverageOptions } from './fixtures/coverage';

// clear coverage from earlier runs
export default function setup(): void
{
  if (coverageEnabled) MCR(coverageOptions).cleanCache();
}
