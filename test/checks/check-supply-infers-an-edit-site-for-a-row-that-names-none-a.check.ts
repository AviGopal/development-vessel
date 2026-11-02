import { describe, test, expect } from 'bun:test';
import * as gapCheckSupply from '../../src/resolvers/gap-check-supply';

// The Row type is complex and not exported, so we'll use a loose type for testing.
// The functions under test are only expected to read a few properties from it.
type Row = Record<string, any>;

describe('check-supply logic for rows missing edit_site', () => {
  /**
   * @see MEDIUM (supply contract; REALIGNMENT §7 step 3: a row missing fields is needs-localization, not actionable)
   * A row with a null `edit_site` should not be dispatched. Instead, it needs localization.
   * The defect is that `checkSupplySite` infers a default `edit_site` (like `src/index.ts`)
   * for the vessel, making the row appear actionable when it is not.
   */
  test('MUST-FAIL: a row with null edit_site should be considered to have no site', () => {
    const rowWithNullEditSite: Row = {
      id: 'the-lanes-falsifier-validity-step-accepts-a-check-that-fails-for-a-shape-reason-so-a-hollow-check-lands-as-the-gaps-falsifier',
      edit_site: null,
      region: null,
      vessel: 'activity-api', // checkSupplyVessel is expected to find this
    };

    const vessel = gapCheckSupply.checkSupplyVessel(rowWithNullEditSite);
    expect(vessel).toBe('activity-api'); // Sanity check that our row is plausible.

    const inferredSite = gapCheckSupply.checkSupplySite(rowWithNullEditSite, vessel!);

    // This is the failing assertion. The desired behavior is for `checkSupplySite` to return `null`
    // when no `edit_site` is specified on the row, preventing a dispatch.
    // Currently, it incorrectly infers a path like 'repos/activity-api/src/index.ts', causing this to fail.
    expect(inferredSite).toBe(null);
  });

  /**
   * A control case to ensure that the fix for the above doesn't break the normal path
   * where a valid `edit_site` is provided.
   */
  test('CONTROL: a row with a valid edit_site has its site correctly returned', () => {
    const rowWithValidEditSite: Row = {
      id: 'some-other-gap',
      edit_site: 'repos/activity-api/src/services/vessel-health.ts',
      vessel: 'activity-api',
    };

    const vessel = gapCheckSupply.checkSupplyVessel(rowWithValidEditSite);
    expect(vessel).toBe('activity-api');

    const site = gapCheckSupply.checkSupplySite(rowWithValidEditSite, vessel!);
    expect(site).toBe('repos/activity-api/src/services/vessel-health.ts');
  });
});
