import type { AdvisorySeverity, DependencyEcosystem, LicenseRisk } from './enums.ts';

/** A dependency recorded by a manifest or lockfile. */
export interface Dependency {
  ecosystem: DependencyEcosystem;
  /** npm `name`, Maven `groupId:artifactId`, Cargo crate name. */
  name: string;
  /** Resolved version, or null when only an unresolved range was available. */
  version: string | null;
  /** Where it was found, repository-relative. */
  source: string;
  direct: boolean;
  dev?: boolean;
}

/** A known vulnerability affecting one resolved dependency. */
export interface DependencyAdvisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: AdvisorySeverity;
  /** Versions the advisory records as fixed, when any. */
  fixed: string[];
  url: string;
  dependency: { ecosystem: DependencyEcosystem; name: string; version: string | null };
  /** Files in the scanned graph that import the affected package. */
  importedBy: string[];
  /** Reverse-reachability from the importing files, by distance. */
  impactedFiles: Array<{ id: string; distance: number }>;
}

/** The license of one resolved dependency, and whether policy denies it. */
export interface DependencyLicense {
  dependency: { ecosystem: DependencyEcosystem; name: string; version: string | null };
  licenses: string[];
  risk: LicenseRisk;
  denied: boolean;
}

/** A complete dependency-risk report for one repository. */
export interface RiskReport {
  available: true;
  /** False when the opt-in online lookup is disabled; inventory still works. */
  online: boolean;
  inventory: {
    total: number;
    byEcosystem: Record<string, number>;
    /** Names cited by source imports but absent from every manifest. */
    undeclared: string[];
  };
  advisories: DependencyAdvisory[];
  licenses: DependencyLicense[];
  /** External packages cited by source imports, with the files that cite them. */
  imports: Array<{
    ecosystem: DependencyEcosystem;
    package: string;
    files: string[];
    /** True when a manifest also declares the package. */
    declared: boolean;
  }>;
  summary: Record<AdvisorySeverity, number> & { deniedLicenses: number };
  /** Set when a manifest was present but could not be parsed completely. */
  caveats: string[];
}
