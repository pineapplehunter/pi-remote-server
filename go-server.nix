{
  buildGoModule,
  lib,
  openssh,
  sqlite,
  tailwindcss_4,
}:
buildGoModule {
  pname = "pi-remote-server";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      (lib.fileset.fileFilter (file: file.hasExt "go") ./.)
      ./go.mod
      ./go.sum
      ./Makefile
      ./styles
      ./templates
      ./public
    ];
  };
  vendorHash = "sha256-N26KrUL+8PYpgdQ3pIs84N6m66dtiO+OCOjHL/+/Npo=";
  subPackages = [ "." ];
  env.CGO_ENABLED = "1";
  tags = [ "libsqlite3" ];
  buildInputs = [ sqlite ];
  nativeBuildInputs = [ tailwindcss_4 ];
  preBuild = "make css";
  nativeCheckInputs = [ openssh ];
  ldflags = [
    "-s"
    "-w"
  ];
  meta.mainProgram = "pi-remote-server";
}
