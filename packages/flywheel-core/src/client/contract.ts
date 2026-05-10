/**
 * Cache for `flywheel_get_contract` and section lookups.
 *
 * The contract is self-describing and includes version/build_sha so we can
 * detect drift. We cache for the lifetime of the client instance.
 */

import type { FlywheelMcpClient } from './mcp.js';

export interface FlywheelContract {
  version: string;
  build_sha?: string;
  sections: Array<{ id: string; title: string }>;
  [key: string]: unknown;
}

export interface FlywheelContractSection {
  id: string;
  title: string;
  body: string;
  [key: string]: unknown;
}

export class ContractCache {
  private contract: Promise<FlywheelContract> | null = null;
  private readonly sections = new Map<string, Promise<FlywheelContractSection>>();

  constructor(private readonly client: FlywheelMcpClient) {}

  getContract(): Promise<FlywheelContract> {
    if (!this.contract) {
      this.contract = this.client.callTool<FlywheelContract>('flywheel_get_contract');
    }
    return this.contract;
  }

  getSection(sectionId: string): Promise<FlywheelContractSection> {
    let p = this.sections.get(sectionId);
    if (!p) {
      p = this.client.callTool<FlywheelContractSection>('flywheel_get_contract_section', {
        section_id: sectionId,
      });
      this.sections.set(sectionId, p);
    }
    return p;
  }
}
