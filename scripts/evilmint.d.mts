// Type declarations for the evilmint mock server (scripts/evilmint.mjs).
export declare const EVILMINT_PORT: number;
export declare const EVILMINT_MINT: string;
export declare const KEYSET_A: {
  id: string;
  priv: string;
  pub: string;
  unit: string;
};
export declare const KEYSET_B: {
  id: string;
  priv: string;
  pub: string;
  unit: string;
};
export declare const EVILMINT_RESIDUE: number;
export declare function evilmintHandler(req: unknown, res: unknown): void;
export declare function startEvilmint(port?: number): Promise<unknown>;
