{
  description = "Supervisor development shell with Node 24 and pnpm 12";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachSystem
      [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ]
      (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          # use the patched official release independently of nixpkgs' node version
          nodeVersion = "24.22.1";
          nodeAssets = {
            x86_64-linux = {
              file = "linux-x64.tar.xz";
              hash = "sha256-bBcqmrZxj3uAH7WnvUhq8u5eMnWAhqBLhPzOKqdwleY=";
            };
            aarch64-linux = {
              file = "linux-arm64.tar.xz";
              hash = "sha256-26v3ocv5R+YFn/rSwnuABB25feoeVTtir97n8T/KM24=";
            };
            aarch64-darwin = {
              file = "darwin-arm64.tar.xz";
              hash = "sha256-ZUunneYVVkfiIyGTK0Xyocy3BZdswzfJuOJ4vrCFpig=";
            };
          };
          nodeAsset = nodeAssets.${system};
          nodejs = pkgs.stdenv.mkDerivation {
            pname = "nodejs";
            version = nodeVersion;
            src = pkgs.fetchurl {
              url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${nodeAsset.file}";
              hash = nodeAsset.hash;
            };
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];
            dontConfigure = true;
            dontBuild = true;
            dontStrip = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -R . "$out"
              runHook postInstall
            '';
          };

          # pnpm 12 ships a native executable with node-gyp beside it in dist/
          pnpmVersion = "12.14.0";
          pnpmAssets = {
            x86_64-linux = {
              file = "pnpm-linux-x64.tar.gz";
              hash = "sha256-ORDDhSE2vtW8FRG5E3pF/UNX7Ws5cNnQiJNkHpAFhn4=";
            };
            aarch64-linux = {
              file = "pnpm-linux-arm64.tar.gz";
              hash = "sha256-z8eAueaQVJ5mM+EEX7H7bvhOOQcR4gmebMuukcMkVuo=";
            };
            aarch64-darwin = {
              file = "pnpm-darwin-arm64.tar.gz";
              hash = "sha256-UPSODhdQiVJ5Cj+/WPzxTzuC76X1lMoErZBOKar4VLA=";
            };
          };
          pnpmAsset = pnpmAssets.${system};
          pnpm = pkgs.stdenv.mkDerivation {
            pname = "pnpm";
            version = pnpmVersion;
            src = pkgs.fetchurl {
              url = "https://github.com/pnpm/pnpm/releases/download/v${pnpmVersion}/${pnpmAsset.file}";
              hash = pnpmAsset.hash;
            };
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];
            sourceRoot = ".";
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/lib/pnpm" "$out/bin"
              cp -r pnpm dist "$out/lib/pnpm/"
              chmod 755 "$out/lib/pnpm/pnpm"
              ln -s "$out/lib/pnpm/pnpm" "$out/bin/pnpm"
              ln -s "$out/lib/pnpm/pnpm" "$out/bin/pn"
              ln -s "$out/lib/pnpm/pnpm" "$out/bin/pnx"
              ln -s "$out/lib/pnpm/pnpm" "$out/bin/pnpx"
              runHook postInstall
            '';
          };
        in
        {
          devShells.default = pkgs.mkShell {
            packages = [
              nodejs
              pnpm
            ];
          };
          formatter = pkgs.nixfmt;
        }
      );
}
