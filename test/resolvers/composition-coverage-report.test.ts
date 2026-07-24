import { resolveCompositionCoverageReport } from '../composition-coverage-report';
import { fetch } from 'node:fetch';

jest.mock('node:fetch');

describe('resolveCompositionCoverageReport', () => {
  it('should return composition coverage report', async () => {
    const pointer = { type: 'composition_coverage_report' };
    const expectedResponse = { shape: 'composition_coverage_report', body: {} };
    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const result = await resolveCompositionCoverageReport(pointer);
    expect(result).toEqual(expectedResponse);
  });
});