// the paths of the built dist/cli.js and of an installed bin from the packed tarball, and the shebang the build keeps

export interface InstalledBin {
  // dist/cli.js of this checkout, built by this run
  readonly builtCli: string;
  // the pnpm-generated bin link in a temporary global prefix
  readonly installedBin: string;
  readonly packageDirectory: string;
  readonly root: string;
}

export const shebang = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";
