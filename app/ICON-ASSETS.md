# AgentCall application icon

The Android and desktop applications share the teal call artwork in
`artwork/agentcall-app-icon.png`. The checked-in source is the square master
used to derive every platform asset.

Android includes density-specific legacy square and circular launcher icons
plus adaptive foregrounds. A matching diagonal teal adaptive background keeps
circular, squircle, and rounded-square launcher masks balanced without
clipping the handset or signal waves.

The Windows installer uses the multi-resolution `build/icon.ico`; Linux uses
the 1024px `build/icon.png`. The desktop navigation and Android gateway header
use the same artwork. Regenerate every density and every desktop copy together
when the master changes. Do not replace a single density or bake a
platform-specific mask into the master.
