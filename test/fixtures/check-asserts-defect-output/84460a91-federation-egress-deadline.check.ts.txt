import { describe, test, expect } from 'bun:test';
import * as mod from '../../src/index';

describe('The federation egress hop', () => {
  test('has no deadline, so each caller must provide one', async () => {
    let dialProtocolOptions: any;
    let fetchOptions: any;

    const mockVl: mod.VesselLibp2p = {
      node: {
        dialProtocol: (_target: any, _protocols: any, options: any) => {
          dialProtocolOptions = options;
          throw new Error('mock dialProtocol from test');
        },
        services: {
          http: {
            fetch: (_peer: any, options: any) => {
              fetchOptions = options;
              throw new Error('mock fetch from test');
            },
          },
        },
      } as any,
      peerId: '12D3KooWSoL4WRo92d3J4BKq1v1pCqH2L2iV3wD1gmyf5UgZ2yqY',
      advertiseMultiaddrs: () => [],
      health: () => ({} as mod.TransportHealth),
      stop: async () => {},
    };
    
    const validPeerIdString = '12D3KooWSoL4WRo92d3J4BKq1v1pCqH2L2iV3wD1gmyf5UgZ2yqY';

    // Test resolveViaLibp2p: it should pass a timeout signal, but doesn't.
    await expect(
      mod.resolveViaLibp2p(mockVl, validPeerIdString, { type: 'test' })
    ).rejects.toThrow('mock dialProtocol from test');

    // This assertion will fail, reproducing the defect that no signal is passed.
    expect(dialProtocolOptions?.signal).toBeDefined();

    // Test resolveViaHttp: it should also pass a timeout signal, but doesn't.
    await expect(
      mod.resolveViaHttp(mockVl, validPeerIdString, { type: 'test' })
    ).rejects.toThrow('mock fetch from test');
    
    // This assertion will also fail for the same reason.
    expect(fetchOptions?.signal).toBeDefined();
  });
});
