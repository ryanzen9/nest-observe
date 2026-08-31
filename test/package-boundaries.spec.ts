import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';

describe('public package boundaries', () => {
  it('does not force applications to install a database-specific instrumentation', () => {
    expect(packageJson.dependencies).not.toHaveProperty('@prisma/instrumentation');
  });
});
