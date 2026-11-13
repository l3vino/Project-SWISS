# Switzerland, streamed

A 3D reconstruction of Switzerland built from live swisstopo open data, rendered
with WebGPU. No frameworks, no build step, no API keys.

## Running it

Open `index.html` with VS Code's Live Server (or any static server) and go to the
URL it prints. Opening the file directly with `file://` will not work: ES modules
and `fetch` both need an HTTP origin.

Requires Chrome or Edge 113+ on desktop. There is no WebGL fallback by design.

The loading screen shows the build number (`js/build.js`). To update, replace
the whole folder and reload: before anything runs, `index.html` revalidates
every file of the app (listed in `files.json`), so the browser cannot keep
running old copies of some modules, whatever caching headers the local server
sends. Every thread reports its build at start; if they differ, the app says
so and does not start on a mixture.

The render scale is kept to a frame rate (Graphics → Quality → *Keep the
frame rate*, on by default, aiming for 60 fps; `js/engine/autoscale.js`, 5.17l,
his words on a laptop whose Intel Xe-LPG drew 2559 × 1389 at 37 fps: "fps is
terrible"): as Unity HDRP's dynamic resolution, the GPU's time is averaged over
groups of 20 frames; after two groups over 92% of the frame's budget the scale
goes down at once to what should fit with room (the pixels go with the scale
squared), after six groups under 62% of it up 5%; never under 50% nor over the
render scale set. Each change resizes the canvas, so it changes rarely: a GPU
that takes 25 ms a frame at full size is drawn at 75% (14 ms) after 39 frames
and stays there (`node tools/autoscale-test.mjs`).

If the GPU is reset while the app runs (Windows' DXGI_ERROR_DEVICE_HUNG), the
message says where and when, how long the GPU's last frames took and what they
drew, the slowest passes, the GPU memory held, what was made and destroyed on
the GPU in the 3 s before (`js/engine/journal.js`) and the browser's version;
it is kept in the browser and said again at a start that fails (after two
resets Chrome turns WebGPU off for the site until Chrome is started again).
The ground under a portal is taken from terrain tiles the tunnels load
themselves; one that fails to come (a timeout under load) is asked for again
up to five times, 2 s later and three times longer each time, before a
coarser one stands in for it (up to 5.17i a failure counted as a tile the
service does not have: a coarse tile over the hillside stood in for good,
and a portal's floor came out metres too high, the road pulled up to it).
Flying in a tunnel goes in steps of half a metre at most, each held inside
the bore; one that would leave it under the ground goes only along the tube,
and stops if that leaves it too (up to 5.17i a fast step left the bore and
the hillside over it was the ground: you were set on top of it).
5.17i is 5.17d's GPU work with 5.17e's placement of the tunnels (see Tunnels):
5.17e's cut of the ground along each tube is the one thing the GPU check of
5.17h found the GPU reset with, and comes back in a later step. Graphics →
Diagnostics → *Open the ground at tunnels* and *Open buildings at tunnels*
switch off what is opened round the tunnels, each on its own, to find which a
GPU does not take.

## Controls

Click the view to take the mouse. **E** frees it for the search box and the
menus without leaving fullscreen, and takes it back again, like an inventory
key; **Esc** gives everything back (with the mouse already free, Esc leaves
fullscreen). **Double-tap Space** (or **F**) switches between flying and
walking. **O** or the Settings button opens the settings (freeing the mouse
and keeping fullscreen, like E), **F3** shows or
hides the readout, **F2** the performance panel. Every key can be changed in
Settings → Controls → Keys: click a key, press the new one.

*Flying:* **WASD** moves along your heading, **Space** and **Left Shift** change
altitude, the **scroll wheel** changes speed, **Ctrl** triples it. Where you are
looking never drags you up or down, and the ground is solid. Two keys together
(W with D, or W with Space) go no faster than one: until 5.11b climbing while
moving was 1.41 times as fast.

*Walking:* **WASD** walks at 1.4 m/s, **Ctrl** with W runs at 4.5 m/s,
**Space** jumps 45 cm and holding it keeps jumping, **Left Shift** sneaks. It
moves by **Minecraft's rules** (Java Edition), tick by tick, 20 ticks a second,
at a person's speeds: on the ground you are up to your pace, and stopped
again, within a quarter of a second (most of the way in the first tenth); in
the air the speed you have fades 9% a tick and the keys add a fifth of what
they add on the ground, so a jump carries you on and cannot be stopped or
turned in mid-air. A jump only starts from a tick on the ground, so between two
jumps with Space held there is always one, and the keys held then decide: with
nothing held about half the speed goes at each landing (after three hops you
stand), with W held you keep going. Running jumps get Minecraft's push forward
at take-off: Ctrl, W and Space held go 1.2 times as fast as running (Minecraft
1.27; its jump is a little shorter than a person's 45 cm). Let go of every key
in a running jump and a third of the run is left as you land. Diagonals are as
fast as straight on, in the air too. **Sneaking** goes at 30% of your walking
pace with your eyes and body lower (Minecraft's 1.27 of 1.62), and you **never
step off an edge higher than a step** (40 cm): walking towards a roof's edge, a
wall's top or a drop, you stop with your middle at it (where your feet stand)
and slide along it; on the terrain, whose cliffs are steep slopes, ground too
steep to stand on is an edge too. Where there is no room to stand up you stay
crouched, and as slow, until there is.

The air slows you by the drag of your own body, ½ ρ v² Cd A against the way
you move, with A the area your body turns that way (Settings → Character →
Body: height, width across the shoulders, depth front to back, weight): facing
the wind a standing adult has about 0.8 m² of it, as measured on people, side
on less, feet first least, though limbs and clothes catch far more than the
top of you alone, so falling upright tops out near 230 km/h at sea level and
270 km/h at 3,000 m, as fast as freefliers fall. Heavier falls faster and
keeps a thrown speed longer. Walking and jumping it is too small to notice.
Switching to walking in mid-air drops you with real gravity and that drag and
**keeps the flight's speed and direction**, all of it, up and down too:
thrown forward at 120 m/s at sea level, 67 m/s is left after a second and 34
after three, 185 m on; facing across the way you are thrown, the narrower
side slows you less (at 3,000 m 88 m/s after a second, against 76); from
1,000 m/s at 3,000 m, 173 m/s after a second and 63 after three, 570 m on.
Climbing at 50 m/s and switching with F, you carry on up 100 m before you
fall (128 m without the air); a double tap of Space keeps the climb or the
descent you were flying just before the taps, since the taps themselves are
presses of fly-up and add nothing (from a hover you simply drop); bailing
out of the airplane keeps all of its speed. However fast, no step of the fall moves
more than 2 m between two checks of the ground and the walls. From 6,000 m the
fall takes about 80 s. Where the ground below has not loaded yet you are held
in the air until it has, and the air keeps slowing you meanwhile: held 4 s,
120 m/s is down to 26 m/s, and you carry 28 m in the first second of the fall
rather than 101 m. Ground steeper than 45° cannot be climbed and slides you
off. All of these, and your height, are in Settings → Character and → Physics.

*Airplane:* **P** puts you in the cockpit of a fighter jet, and takes you out
again. It flies by itself: **W** and **S** push the nose down and pull it up,
the stick asking for its share of what the wing can lift at that speed (let
go, it holds the climb or the dive), so, as in a real jet, the faster you go
the tighter it pulls round, until the structure's limit (12 g, as built 9 g)
is reached at the corner speed, about 750 km/h, beyond which the turn widens
again: a full pull turns the path up 7° a second at 300 km/h, 23° at 600,
30° at 750 and 19° at 1,200 (as built 3°, 15°, 20° and 14°; in a pull-up
gravity takes one g off). By default you look **along the flight path**,
where it is really going, so the view turns up exactly as the jet does; *View:
Nose* looks along the nose as from a real cockpit, where pulling brings the
nose up first and the jet follows a moment later (5.10b's only way, his words:
"it looks up quick, but the actual plane pitch is slower"). **A** and
**D** roll it left and right so it banks and turns as an airplane does: the
roll builds up over 0.8 s to 90° a second at 600 km/h, and is quicker the
faster you go, as an airplane's ailerons are (45° a second at 300 km/h, 180°
at 1,200, 240° at the most; until 5.13b 90° at any speed), so a tap is a small
correction (at 700 km/h 0.1 s tilts it half a degree and 0.3 s 5°; a second
held at 800 km/h, about 60°), and let go, the wings come back level, unless you are
pulling or pushing (*Wings level themselves* off holds the bank, as a real
fly-by-wire jet does). The **scroll wheel** sets either the speed you want
(*Scroll sets: Speed*, the default: an autothrottle gets there as well as the
engine can, up to Mach 2) or the throttle itself (*Throttle*, the Realistic
preset: idle to full dry thrust, 100%, and on into the afterburner, AB; the
speed is then whatever thrust, drag and gravity make it). A single notch is a
fine step, 5 km/h or 1%; scrolling on quickly makes each notch bigger than
the last, up to 100 km/h or 10%. The engine is an F-16's own by default
(*Engine and brakes: As built*), so the air's drag shows: pulled straight up
from 900 km/h it slows to about 520 km/h in 25 s, a 30° dive from 700 km/h
speeds it up to about 1,030 km/h, and a hard turn bleeds speed; *Quick* (1.5
times the thrust, and a speed brake four times as strong that opens by
itself 15 km/h over the speed asked: 450 to 850 km/h in about 10 s and back
in 14 s, as built 14 s and over two minutes) changes speed sooner, but it
even speeds up going straight up, and its brake holds the speed in a dive
(the default until 5.13b). **Left Shift** is the speed brake (and the wheel
brakes on the ground), the mouse looks round
the cockpit and the view eases back when you stop, and
double-tapping Space bails out, falling at the jet's speed. The jet is an
F-16 as far as public numbers go: 1,600 km/h at the most at sea level (Mach
1.3), Mach 2 at 11 km, about Mach 1 without the afterburner; by default its
wing has half as much lift again and takes 12 g (*Wing: Stronger*; as built,
9 g). **Scrolled down to nothing, the engine is off** (until 5.11b it idled,
at 9% of full dry thrust): with the quick engine the speed brake comes out by
itself and slows it to the least speed it flies at (1.3 times the stall
speed: 900 → 280 km/h in 24 s at 2,000 m), then closes. Left level, it gets
slower still and **stalls**, as a real one does (his answer: "realistic, so if
user doesn't manouvre to glide, it stalls, if user does things correctly, it
glides"): at about 245 km/h level at sea level as built, 200 km/h with the
stronger wing; the nose drops, it falls until it has flying speed again (5 s
and 60 m from 2,000 m) and then holds the dive it is in, so pull out gently
or it stalls again; with S held it stays stalled, falling 45 m/s with the
nose 40° above the way it falls. Lowered in time, the nose keeps it flying:
about 6° down it glides at 475 km/h, sinking 13.5 m/s (steeper, faster). The
pulls the stick asks for never stall it: the fly-by-wire keeps the wing under
its peak, at 25°. From walking you sit in it parked on the
ground with the engine off: scroll up and it rolls, pull back at about
280 km/h and it takes off. From flying it flies on at your speed (600 km/h at
least). The ground, buildings and bridges are solid: touch down gently
(sinking under 3 m/s, wings level, nose not down, under 400 km/h) and it
lands and rolls; anything harder, or any wall, is a crash, and you are back
to flying where it happened. The view shows only a pointer, a dot in the
middle: where you are going, or where the nose points with *View: Nose* (it
fades while you look round). Settings → Vehicles → Airplane
display turns on whatever else you want, each on its own: the horizon and
pitch lines (the attitude: drawn round where you look and on both sides of
straight up and down, so through loops, barrel rolls and rolls into a pull
they turn with the view and never jump; until 5.12b they were drawn round the
nose's heading, which flips at the vertical and is not where the view looks
along the flight path), the flight path marker (where the jet is really
going), the speed with the speed asked (or the throttle), Mach and g, the altitude above the sea
and the ground with the climb, the heading, the throttle (and afterburner)
and the warnings (STALL, BRAKE, ON GROUND); with only the pointer on,
nothing is drawn a frame. Its presets: *Easy*, the default (the wings level
themselves, the view along the flight path, the stronger wing, the engine as
built, the wheel on the speed, only the pointer), and *Realistic* (the bank
holds, it rolls 180° a second at 600 km/h within 0.2 s, the view along the
nose, the wing and the engine as built, the wheel on the throttle, the whole
display); *Advanced* under them has the roll rate and its build-up.

Buildings and bridges are solid. Walls stop you and you slide along them, kerbs
and stairs up to 40 cm are stepped up, and you can stand on roofs, terraces and
bridge decks. They are solid while flying too, the way the ground is, at any
height: wherever anything built within reach stands up to near your height
(Basel's 205 m Roche tower included), everything round you loads with its
collision copy, as far ahead as two seconds take you at the speed set (up to
240 m); in the airplane, and falling fast after a flight, it lies ahead along
the way you go instead, as far as four seconds take the airplane (two the
fall), up to 960 m ahead (until 5.11b, 240 m round the airplane: 1.4 s at
600 km/h). Only a search flight skips the checks, as it keeps clear by its
plan. Settings → Physics → *Fly through buildings* turns them off.

You stand on the terrain being drawn, which under your feet is swisstopo's
finest level, a few metres between vertices. Physics only ever stands on
accurate ground: level 14 and finer (about 5 m of error), or the finest the
service has at that spot. While terrain streams in, the first tiles to arrive
are coarse stand-ins whose surface can be kilometres above a valley floor, and
those never lift you: flying, there is simply no floor until accurate ground is
there; walking, you wait where you are (the readout says *waiting for ground*),
unless you are falling from high above everything, which carries on. Moving
below 800 m faster than 30 m/s, the whole column of tiles under the point two
seconds ahead (four in the airplane) is requested at once, so the ground is
usually there before you are. Wherever physics needs ground and only a stand-in is loaded (under you,
40 m around you while walking, where a flight to a place will end), the column
of tiles there is requested the same way: the view only refines what it sees,
and the ground behind you is out of view.

**Ctrl K** focuses the search box, except while flying. Picking a result
**flies you there**, calmly. Seen from above the path is **one continuous S**:
it leaves the way you face (unless that way is closed in: it looks all round,
every 5°, for the gentlest climb out, and takes the nearest one to the way
you face, well inside the open side, so facing a wall it turns its back on it
and climbs at 60° rather than 70° or more up the wall), curves towards the place, hands over round the
middle to a curve the other way without ever going straight (the turning
passes through nothing only for an instant, so the bank rolls through level
at a steady pace) and curves back, so it always leaves going forward and
arrives **facing exactly the way you were, tilted as you were**. It is always
an S, right then left or left then right, whichever is quicker; never a loop
(a place behind you took one in a quarter of the trips before, straying as
far off the line as the place is away). The curves are
shaped in time: at its own pace the path never turns faster than 20° a
second, and its turning changes by at most 15° a second each second (about
where a turning view starts to make people queasy; played faster to fit
*Longest flight* or a higher *Flight speed*, it turns that much faster), tight where the flight is slow and low,
wide where it is fast and high. Seen from the side it **rises, flies and
comes down, never up and down again**: from the ground, where there is room
round you, it leaves at about 30° and curves up into a 60° climb within its
first 10 m (33° a metre up, 56° ten metres up), then leans into level
flight across the whole climb, the way it curves down onto the place at the
end; steeper at once where something stands close, straight up only when
boxed in; the same in reverse at the place.
Starting in the air, well above everything near, it leaves **level**, the way
you face, and curves up into its climb the way it curves down from the cruise
at the end. **The view tilts up and down at most 25° a second** at the
flight's own pace wherever it can (Stage 5.11b, his words: "on long S flights
make the vertical curve less sharp"; 5.10b tilted it at up to 100° a second
where the climb bent over into the cruise): climbs and descents lean into
level across their whole height, from the air (and coming down into the air
at the end) they climb at 20° to 60°, as steeply as that allows, and where it
is still more (a 60° climb from the street on a quick trip) the flight is
made up to 1.5 times longer. From 300 m up to a place 20 km off it climbs at
30° and tilts at most 21° a second; walking to a place 2 km off, 24° a
second, 1.35 times longer. Where it must rise straight up (out of a
courtyard, beside a tall wall) the bend into the cruise is still quick, up
to about 180° a second (5.10b: 225°). The
**camera is the path**: it looks exactly along it, its heading and its slope
(89° at most), however fast that changes; only while rising the first 100 m
does it turn from your view onto the path, and back onto yours over the last
100 m. **Every trip from 300 m on is an S**, wherever the place is, behind
you too, and however fast it must turn to fit *Longest flight*; where the
climb and the descent alone would carry it past the place (a short trip high
up), it first rises straight up part of the way to the cruise, and comes down
straight at the end, the S between. It banks with how
fast it turns and leans towards the straight line between the ends (*Bank in
turns*, 15° at the most). The speed is **one bell**: from rest, fastest
exactly halfway, to rest at the end, without a kink (the minimum-jerk curve),
measured in heights above a smooth line from the ground where you start to
the ground at the place, so it never slows down over a mountain in between;
1.5 heights a second at the fastest. A flight takes 3 s at least, about 5 to
20 s to places ahead and up to *Longest flight* (30 s) to places beside or
behind you; *Flight speed* plays it faster or slower, turns and all. A trip
**under 300 m flies one arc** straight to the place, its curvature continuous
all the way: a parabola that arrives at 60° (it leaves as steeply as the
height between the ends makes it, level where the place is far below), its
top about four tenths of the distance high, **your view kept as it was** all
the way, so it arrives facing the way you faced (Stage 5.11b, his words: "when
hop is close, don't turn the camera"; until then the camera turned onto the
arc and ended facing the way it went); something in the way steepens it into
an arch, and where only a climb far higher than the trip is long clears it,
the arch stands on straight sides; 3 to 6 seconds. A hop under 30 m flies
**one parabola**, the view kept as well.

A **blue glass line** shows the way still ahead, with a bead every 1.5
heights: as thick as a share of the height above the ground, so it thins with
distance like everything else (down to a fine thread, never quite gone), lit
by the sun and the sky, hazed by the air, faint and dashed where mountains or
buildings hide it (*Show the flight path*). The camera flies down its middle,
so you look along the tube; it fades out close to you. The **place's name**
floats over it, white with a soft shadow, the same size near or far and over
everything, with its **distance** under it, counting down as you fly; under
them a hairline of the path's blue rises from a small blue dot in a white ring
with a soft glow, whole on the place and fading out towards the name (hidden
by whatever stands in front of the place). When the place is off the screen
or behind you, a small round glass chip at the edge of the screen with a
chevron in it points the way, the name and the distance beside it (*Show the
destination name*).

It **hits nothing it knows of**: every point keeps a clearance above the
highest thing anywhere in a corridor round it, and **before it sets off the
whole path it will fly is checked** against what is there, point by point (a
thousand of them, densest low down, each over everything within half a metre
and half the way to the next); where it would pass nearer than its own margin
(a metre, less near the ends as the plan keeps less there) it is planned
again round what is there made wider and higher, and the clearer flown. Four
times a second on the way the path ahead is looked at again: should
something stand in it after all, the way rises over it, as high as the plan
keeps over things there, and comes back down after it. The terrain answers from a
16 × 16 grid of each tile's highest points, plus a margin for the detail its
level leaves out; buildings, bridges and cable cars from each loaded tile's
own grid of highest points (ropes and pylons included), else from their
tilesets' bounding volumes, and round the start and the landing exactly,
triangle by triangle; where nothing is known, Everest. Clearance and corridor
grow with the distance, so a hop of 10 m stays 2 m up and a long flight passes
high over everything. It is planned once, at the click, and flown as planned:
what loads on the way does not make it swerve. What the flight learns on the
way only reshapes the part still ahead (a landing spot found, better ground
at the place), along smooth curves from where the flight is, so neither its
height nor its speed jumps: sideways while still high, and down only from
where the way on is clear coming down (beside a house it was to land on, not
through its roof). From take-off on, everything the view will show on
arrival loads (its terrain, buildings and photos, the photos decoded and
compressed ahead, ready to go straight to the GPU), with half the decode
threads, and first of all in the flight's second half; along the way, the
faster the ground streams past, the less detail is asked for. The flight
**keeps its pace** from the click to the arrival, worked out once: it never
slows down to wait for the place (until 5.10b it did, for 5 s at most), and
what has not loaded by then streams in after. It ends at **the same height above
the ground** as it began, above anything standing there. **Walking, you land
on the ground and walk on**: from take-off on, everything within 100 m of the
place is loaded with its collision copy and the nearest spot where a body
fits, outside every building and with nothing over it, is found, one with
**room round it** where there is one near: 1.5 m clear of anything built that
rises over a step (looked for up to 15 m beyond the nearest spot a body merely
fits, which is taken where there is none). Coming down onto it the flight keeps
that far from what is there, except right over the spot, which is open sky
down to the ground. It **never
lands on a guess**: while that spot is not known the flight heads for a point
over the place, 30 m above the ground or 10 m above the highest thing round
it, and comes down onto the spot as soon as it is found (across, then down:
the two overlap only where that keeps as clear of what is there, else it is
all the way across before it comes down),
no faster than the flight's own pace: where the way down would only be clear
of what is known round the place in its last moments (only coarse tiles
loaded there yet), it arrives over the place first and comes down from there
in a few seconds (until 5.11b such a way down could drop 60 m in half a
second and overshoot under the ground for a moment); if the spot is still not
found 15 s after arriving there, you stay up there, flying, and a note says
so. Where there is no open ground at all (an old town's
courtyards), you land **standing on the roof** there. A flight ending below
50 m lands the same way, at its height (over the roof, where there is no
open space at that height). Picking the house you are standing beside lands
you beside it again, as from anywhere else (until 5.13b it could land you
inside it: the search for the spot then saw almost none of that house). For
15 s after you land, buildings that load
round you still count: if one comes to stand where you are (you inside it, or
a wall through you: standing close to one is no reason), you are moved out to
the nearest open ground with room and a note says which (until 5.11b it was
looked at once); arriving flying, you are lifted onto the ground the view draws if a
coarser tile of it is above you. Moving the mouse on the
way turns your head, easing back when you stop; a movement key takes over
where you are (a bank then levels out). Outside Switzerland there is no
terrain yet: you arrive at least 150 m up, and a note says so. Picking a
result also gives the mouse back to the camera, so you can look around at
once. **Picking another place on the way** arrives as the first flight would
have: as high over the ground (from 360 m up, 360 m up there), walking or not
(from walking, you land walking), facing the way you faced; and the flight to
it goes on from the speed and the way you are going, no stop: it leaves the
way the camera is going (still climbing, at the slope it climbs at), its clock
read so that it sets off at that speed, and whatever else the old motion has
(coming down where the new way climbs, say) is given up over the first second
and a half; the view turns from where it looked onto the new path. In Settings → General → Search flights: *Fly to search results* off
puts you there at once (and onto the same height above the ground as the
ground there loads, within a few seconds); *Flight speed*, *Longest flight*, *Bank in turns*,
*Show the flight path* and *Show the destination name*; *Take the mouse after
picking a result* (under Interface) off leaves the mouse free.

In the browser console, `swissgpu.probe()` shows the camera and physics state
right now (and the last search flight: its plan, how ready the place was,
how close it came to the ground), `swissgpu.bounds(lon, lat, radius)` what a search flight
would keep clear of there (the terrain's bound and estimate, each building
layer's, the total), and `swissgpu.send(type, payload)` sends the render
thread a message.

The search bar has a **Global / National** switch, remembered between visits.
**Global** asks Open-Meteo, which indexes cities and towns worldwide from
GeoNames with no key, so looking up New York from Switzerland works. Its free
tier allows 600 calls a minute and 10,000 a day; search sends one request per
pause in typing, so one person never gets near that. **National** asks the country source for what is on screen, swisstopo
today, which also knows addresses, summits and field names. Near a border it
asks every country in view and merges them.

While the pointer is captured, browser shortcuts are suppressed so they do not
fire mid-flight. The reserved ones — Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab — ignore
`preventDefault` entirely and need the Keyboard Lock API, which only works in
fullscreen, so clicking the view also goes fullscreen. That is Settings →
Controls → *Capture browser shortcuts*, on by default. Turn it off if you would
rather keep the browser chrome and DevTools visible; Ctrl+W will then close the
tab, which matters because Ctrl+W is how you run.

## What is here

The engine spine, running end to end:

- **Threads.** The page thread starts a render thread and a pool of decode
  threads, all spawned from Blob URLs. The render thread owns the WebGPU device
  and the canvas through `OffscreenCanvas`, so the page thread never renders.
- **Native core.** The C under `wasm/src/` is compiled to a 36 KB wasm module,
  compiled once by the browser, then instantiated separately in every thread so
  each one gets a private heap and a bump arena.
- **Transfers.** Buffers move between threads by transfer, never by copy. Boot
  fails loudly if that stops being true.
- **Renderer.** Reverse-Z depth, per-pass GPU timing where the hardware exposes
  it, adaptive render scale.
- **Frame pacing.** Every GPU upload of arriving tiles goes through one queue
  that spends at most a quarter of a frame, and never more than 2 ms
  (`js/engine/uploads.js`), so a burst of tiles spreads over a few frames
  instead of making one late, at 60 frames a second and at 400 alike. The
  mouse is read through `pointerrawupdate`, close to every report the mouse
  sends rather than one batch per page frame, summed and sent to the render
  thread at most every 2 ms (a gaming mouse reports up to 8,000 times a
  second), and without the operating system's acceleration where the platform
  allows. A profiler (`js/engine/profiler.js`) splits each frame into physics,
  uploads, view, terrain and building selection, memory drops, housekeeping,
  the ground index, imagery, pass recording and submission; the readout shows
  the real work per frame, its 99th percentile, and how many frames came late
  in the last five seconds.
- **Work that does not grow with what is loaded.** Per-frame work scales with
  what is on screen, never with everything loaded since the session began.
  Loaded tiles are kept in least-recently-used order in a linked list with a
  marker (`js/engine/lru.js`, the way Cesium keeps its 3D Tiles cache): a
  selection marks what it uses, and dropping tiles to stay within memory takes
  the longest-unused from the head of the list, finer before coarser, without
  ever scanning or sorting the loaded tiles. When the view in front of you needs
  more than the memory budget holds, nothing unused is left to drop, and detail
  is lowered a step instead (the readout says so, in red), and raised again
  once there is room. A selection keeps only the few dozen most urgent tiles it
  would like loaded (`js/engine/topk.js`) instead of sorting hundreds.
  Housekeeping (forgetting empty branches of the terrain tree, letting go of
  collision copies far away, forgetting building files unused for a while)
  works from short lists a few hundred nodes at a time on a clock, not by
  walking the whole tree every so many frames. Hot code allocates nothing per
  frame. On the real swissBUILDINGS3D tree, flying at 150 m/s with memory
  full (`tools/bench-streaming.mjs`), this took the building streamer's cost
  per frame from 3.5 ms to 0.18 ms on average and its 99th percentile from
  7.8 to 0.34 ms, while memory now stays at its budget instead of four times
  over it; with memory to spare, the 99th percentile went from 7.1 to 1.2 ms.
- **Loading.** Everything the decode threads do goes through one scheduler
  (`js/core/scheduler.js`): at most four jobs per thread and 24 per host in
  flight, so a tile that becomes urgent waits behind a handful rather than
  fifty; what physics waits for (the ground under you, collision copies, the
  buildings where a flight will land) first; then the view, shared between
  terrain, photos and each building layer by deficit round robin, so heavy
  Draco buildings cannot crowd out light photos; preloading last. Ten times a
  second it calls off jobs for tiles the view has left, which aborts their
  downloads on the decode threads. What an answer means is decided once
  (`js/core/net.js`): nothing there (403, 404, 400, 410, 204) is never asked
  for again; a server error, a timeout or "too many requests" is tried again
  after 1, 2 and 4 s with jitter, or when the server asks (Retry-After), and a
  429 halves how many requests go to that host at once, which then recovers
  one at a time. While you move, buildings off the centre of the view wait
  until you slow down (a second at most) and tiles you would cross in under a
  second are not asked for at all, as Cesium does. Building tileset files,
  megabytes of JSON with tens of thousands of tiles each, are read on a
  decode thread into compact indexes (`js/formats/tileset-index.js`, 115
  bytes a tile) kept between visits in IndexedDB
  (`js/workers/index-cache.js`, 64 MB); tile objects are made from them only
  as far as the view walks, a third of a millisecond a frame at most, and let
  go again when unused. A terrain tile that physics may stand on brings its
  ground index from the same decode, and a building tile that reaches you
  without a collision copy gets one from its own GPU buffers, not by
  downloading and decoding it again. A flight to a search result loads what
  the view there will need, terrain, buildings and photos, while it flies.
  The buffers a decoded tile arrives in go back to the decode threads once
  its contents are on the GPU and are filled with the next tiles
  (`js/core/buffer-pool.js`), so streaming leaves no garbage outside the
  heap on the render thread, which is what set off its full garbage
  collections. The tree walk reads tile bounds straight from the compact
  indexes, siblings side by side in memory, instead of following a chain of
  small objects per tile.
  Settings → Graphics → *Decode threads* (Auto: half your processor's threads
  less one, 2 to 8) applies at once. On the real swissBUILDINGS3D tree
  (`tools/bench-streaming.mjs`, a 50 s flight at 150 m/s), the render
  thread's worst frame went from about 400 ms (the tileset files were read
  there) to 7 ms, its average from 0.27 to 0.18 ms and its 99th percentile
  from 0.8 to 0.6 ms, with 3,745 tile objects made instead of 74,010.
- **Performance panel** (**F2**, or Settings → General). Frame times as
  percentiles, the render thread's time per section (mean, 95th percentile,
  worst), the GPU's time per pass and for the whole frame, draw calls and
  triangles, memory per layer against its budget, what is streaming, and
  which GPU the browser actually picked, with everything it says about it.
  *Copy report* puts all of it on the clipboard as plain text; *Pause
  streaming* stops new requests, which separates the cost of loading from
  the cost of drawing.
- **Adapters, routed by area.** `registry.js` answers "who serves this
  rectangle?" per tile rather than per session, so a tile on a border is
  offered to each source in priority order and an unmapped region is simply
  never requested. National search asks every country source covering the
  current view at once and merges the results; Global asks the worldwide index.
- **Terrain.** Quantized Mesh tiles from swisstopo (swissALTI3D, levels 0 to
  18), decoded in C on the decode threads, uploaded as 24-byte vertices.
  A quadtree picks the detail per tile by distance: the finest level is kept
  out to the *Full terrain detail* distance (150 m by default) and each coarser
  level reaches twice as far, which gives level 17–18 under your feet and
  coarse tiles at the horizon. Only tiles in view are visited; a parent stays drawn until
  every child in view has arrived, so refinement never opens holes; requests
  go out nearest first; a memory budget drops what has been out of sight
  longest, and lowers distant detail when the view alone needs more (see
  above). The tiles' own availability metadata says which finer tiles exist,
  so nothing is requested that the service does not have, and where finer
  data stops, the coarser tile keeps covering that quarter. The tiles' own
  per-vertex normals are used, so lighting is seamless across tile edges.
  Skirts are sized per level and face outward, which lets back faces be
  culled. Settings → Graphics → *View distance* stops drawing and fetching
  anything farther and fades the last stretch into the sky behind it; *Full
  terrain detail* and *Terrain memory* are next to it, and *Terrain view →
  Terrain levels* colours each tile by its level.
- **Buildings.** All of swissBUILDINGS3D, streamed as 3D Tiles: nested
  tilesets of b3dm tiles with real roof shapes. A reusable 3D Tiles streamer
  (`js/engine/features/tileset.js`) walks the tileset by screen-space error
  with the same view, culling and memory rules as the terrain, both
  refinement modes included; trees, roads and names will reuse it. Tiles
  decode on the decode threads: the b3dm and its glTF are unpacked in
  JavaScript, then C places every vertex in a local frame per tile and packs
  it into 12 bytes (plain glTF spends 32 or more). Whether swisstopo's tiles
  are plain, meshopt- or Draco-compressed is not documented, so all three are
  read; the Draco and meshopt decoders in `vendor/` load only if a tile needs
  them. Underground and invisible buildings, as swisstopo marks them, are
  dropped. Roofs are coloured by the aerial photo projected straight down, to
  within a few centimetres across a tile.
- **What buildings look like.** On arrival the C core measures every
  building (`mesh_features`): its height, where its eaves are (the lowest
  corner of its roof), the ground it covers and how much of its roof is
  pitched. Rules the adapter declares as plain data
  (`js/adapters/swisstopo-buildings.js`) then give each one a look from
  that, its type in swissBUILDINGS3D, whether the building register lists
  it, the altitude and the region: warm ochre, salmon and rose render and
  bare stone *rustici* south of the Alps, pale limestone tones in the west,
  white and cream on the plateau, log and board chalets on a rendered
  ground floor above about 1,150 m, board barns on a stone or rendered
  base, clad halls, concrete and glass towers, rendered churches with tall
  windows, rubble castles and walls, brick chimneys, metal tanks. The first
  rule that matches wins, so they read as a list of exceptions ending in
  the ordinary house; another country's adapter brings its own. The result
  is eight bytes per building in one shared GPU buffer
  (`js/engine/features/feature-pool.js`): wall colour, material, base,
  kind of openings, shutters, window surrounds, eave height and overhang.
- **Walls.** The materials, render, rough render, rubble stone, cut stone,
  brick, boards, logs, concrete and ribbed metal, are drawn on the GPU at
  start-up into a texture array (`shaders/materials.wgsl`, about 11 MB, a
  few milliseconds, nothing downloaded): each texel holds how much lighter
  or darker than the building's colour it is, whether it is a joint, and
  the slope of the surface, so stones and logs are lit by the sun as relief.
  Every mip level is there and walls are sampled anisotropically, so they
  stay sharp edge-on and settle to their average far away. On top, drawn
  per pixel: windows laid out by the building's own bays and storeys, with
  frames, sills, painted surrounds on some, recessed glass reflecting the
  real sky more the more obliquely you see it, and open louvred shutters on
  others; ribbon windows on offices, a high band on halls, tall narrow ones
  on churches, few and small on old stone; a plinth or a whole ground
  storey of another material; rain streaks under sills; and the shadow of
  the eaves, as deep down the wall as the overhang's shadow really reaches
  for where the sun is, with the sky partly hidden just under it. Every
  detail is filtered against the pixel, fading to its average with distance
  instead of shimmering. Normals come from the screen-space derivatives of
  position, exact for flat faces and free in memory. Settings → Layers turns
  buildings off and sets how far out they are drawn, how far out they keep
  full detail, both in kilometres, and their memory.
- **Bridges and structures.** swissTLM3D's 3D objects, which include the
  country's bridges and cable cars, through the same streamer. The terrain is
  the bare ground with bridges removed, so without them a road over a valley
  is only a picture on the valley floor. They are drawn as concrete, with
  their tops coloured by the aerial photo like roofs, and are solid like
  buildings. Layers → *Bridges & structures*. Which object types the service
  really holds is printed to the console as tiles arrive.
- **Cable cars.** swissTLM3D models every cable car and material ropeway as a
  tube a metre or two thick around its line. On the decode threads the line
  is recovered from the tube (`js/formats/lines.js`: the tube's vertices
  cluster at the line's corners, which are the mast tops, and its long side
  triangles join them) and drawn as what it is (`js/engine/passes/cables.js`):
  ropes sagging between the masts, two strands for tramways, gondolas, chairs
  and drag lifts, real rope thickness, drawn as anti-aliased lines that stay
  a pixel wide and fade with distance rather than vanish in steps; and a pylon
  at every mast, a lattice tower or a slim tube by kind of lift, with its
  crossarm. The tubes are neither drawn nor solid: you fly through ropes.
- **Camera.** Longitude, latitude, height and two angles, with a floating
  origin so float32 vertex positions stay exact. Where you were, and whether
  you were walking, is restored on reload, or you can pin a home.
- **Imagery.** SWISSIMAGE aerial photos as a clipmap: a stack of zoom levels,
  each a 16×16-tile window centred under you in one layer of a texture array,
  from about 435 km across at zoom 10 down to about 400 m at zoom 20. Windows
  are toroidal, so moving only loads the tiles that enter. A level is only
  fetched where it will be sampled: fine ones near you, coarse ones out to the
  edge of the terrain. JPEGs decode on the decode threads and are compressed
  there by the C core (`wasm/src/bc.c`) into the GPU's own block format, so a
  tile arrives ready and costs the render thread one copy. *Photo quality*
  High uses BC7, 8 bits a pixel with sixteen shades in every 4×4 block, which
  keeps the photos free of the grain the cheaper format adds; Standard uses
  BC1, 4 bits a pixel. Either is a quarter or an eighth of plain RGBA. Where a
  finer tile has not arrived yet, the shader falls back to a coarser level, so
  streaming shows as blur, never as holes. Beyond Switzerland the ground keeps
  its altitude colours. Settings → Graphics → *Sharp photo radius* sets how
  far the finest photos reach, *Photo sharpness* trades crispness against the
  shimmer of distant forests, and *Terrain view → Imagery levels* colours the
  ground by the zoom level being drawn.
- **Roads and railways (the data, so far).** Every road, path, track and
  railway line of swisstopo's vector base map (`ch.swisstopo.base.vt`,
  Mapbox Vector Tiles) streams round you: zoom 14 (lines to 40 cm) out to
  *Full road detail*, 1 km by default, and zoom 13 (80 cm, a quarter of the
  download) out to *Road and rail distance*, 3 km; from higher up than a wide
  road is worth (thinner than a pixel and a half), nothing is loaded. The C
  core decodes each tile on a decode thread (`wasm/src/mvt.c`): only the
  layers used are read, every road and track becomes one continuous line
  across junctions with its length along it measured (so dashes and sleepers
  can run on across tiles), and a grid of 128 × 128 cells lists the few
  segments that can reach each cell, in drawing order. The blocks live in
  one GPU buffer (*Road and rail memory*) and two small page tables say where
  each tile round you is; every pixel of the ground finds its own tile, cell
  and segments from its place on the map, the way Thöny, Billeter and
  Pajarola draw vector maps (2018). *Terrain view → Roads and rails (data)*
  shows every line in a colour per kind, bridges bright, tunnels dashed and
  the tiles outlined.
- **Roads on the ground.** Near you every road, farm track, path and flight
  of steps is found per pixel (`shaders/vector.wgsl`), at its own width:
  swisstopo's landscape model swissTLM3D has each road's width class ("4m
  Strasse" is 4.21 to 6.20 m wide, drawn 5.2 m), which a decode thread asks
  swisstopo's identify service for, three calls at a time, for the tiles
  within 600 m (and where a search flight will land, before it does), and
  matches onto the vector tile's segments (`formats/road-widths.js`; the
  tile round Zürich HB takes 20 calls and 1.35 MB the first time, a village
  one call; kept between sessions); until then, and farther out, each kind
  is as wide as most of its roads are. Where the photo shows the road
  (asphalt, gravel, the markings, patches, shadows), the photo is the road,
  sharpened a little, with a fine grain laid over it where its pixels are
  magnified, so it does not look smeared underfoot; no painted band is drawn
  over it. Only where the photo over a road is green (trees or grass grown
  over it: how much greener than both red and blue the photo is, measured on
  666 points of SWISSIMAGE road lines round Airolo, is under 0.012 on paved
  roads at their 99th percentile and above 0.06 only under trees or grass;
  "excess green", 2g − r − b, cannot tell grass from yellowish gravel) is a
  surface made instead, blended in as far as the photo is green: asphalt
  with its grain, gravel, two wheel ruts with grass
  between them, earth paths whose edges wander, stone steps with a riser
  every 30 cm, as bright as the photo there within limits, its edges
  anti-aliased against the pixel's footprint across them. Made surfaces are
  drawn while a screen pixel covers under half a metre of ground. A railway
  crossing a road (a level crossing, a tram in the street) has its rails set
  into it, a groove beside each; the railways themselves come in a later
  stage. A bridge's road is drawn on its deck the same way (the structures
  layer). The lines themselves show in *Graphics → Diagnostics → Terrain
  view → Roads and rails (data)*. *Layers → Roads* and *Paths and trails*;
  *Graphics → Quality → Advanced → Exact road widths*.
- **Terrain under roads.** The streamed terrain has each road on the bare
  hillside, tilted with it (26 to 79% across on the coarser levels, measured
  above Airolo). So the terrain tiles drawn within about 1.2 km are cut as
  they are decoded (`wasm/src/shape.c`): each road, track, path and railway
  bed gets a bench as wide as it plus its verges, level across, at the
  height of the ground along its middle (smoothed), the way Bruneton and
  Neyret shape terrain under vector roads (2008); where a side road meets a
  main road it starts at the main road's height. Beside the bench a face is
  cut into the hillside (45° in earth) or filled out below it (1:1.5), as
  steep as rock is cut where the hillside itself is steeper than earth
  stands; the cross-section is measured every 2 m along the road and
  smoothed along it, and each face is rounded where it leaves the road and
  where it meets the ground (over 1.5 m, as highway practice rounds the
  tops of cuts), with a line of vertices along its crest, so the slopes are
  clean curves rather than saw-teeth. Where two roads' slopes meet (the legs
  of a hairpin, a path beside a road, a junction) the ground is blended
  between what each would make alone, each taking over at its own edge, so
  there is no wall where one gives way to the other. Distances along a road
  are measured on the road itself (the vector tiles' own lengths are the
  dash pattern's, which starts again at the tile's edge: on a hairpin by the
  edge, one leg took the other's heights). The faces take their colours from the
  ground beside them (up the hillside from a cut, down it from a fill), not
  from the photo's road and kerb smeared over them, unless the photo shows
  the bank green (grass, trees over it), which it keeps; steep ones get a
  rock's grain, its beds level. A face is as steep as its own triangle
  (5.17m: its vertices' normals are shared with the level and the ground
  either side, and on a railway's cutting by Giubiasco, walls 10 m high
  leant as little as the ground does, kept the photo's treetops stretched
  down them and were lit as flat ground), and lit as that triangle faces. Where a road comes off a bridge, it starts at the deck's own
  height (read from swisstopo's 3D bridge as drawn, `engine/vector/
  bridges.js`) and eases back onto its ground; where the map's bridge goes
  on past the end of the 3D deck, the rest is built as road on a bank from
  the deck's end. The triangles are split along the benches' and crests'
  edges first, which keeps the surface closed. Tiles are cut each on its
  own, yet where two meet they must agree, or the ground opens there or the
  road steps: every line inserted stops half a metre short of the tile's
  edge, so the vertices on the edge are the ones both tiles came with, and
  within 8 m of the edge the cut follows a rule made only of what both
  tiles have: the road's height along the edge, fitted to the ground on the
  edge itself (level across, no steeper than its kind, by a median of
  slopes, so a wall or a cliff reaching into the width there does not drag
  it off), and faces that steepen until they meet any ground. Neighbouring
  tiles of one level now meet within 3 cm on the roads (above Airolo they
  were up to 19 m apart, the sky showing through, and up to 0.8 m across the
  Gotthard road). A tall fill or a deep cut is made steeper rather than
  wider (reaching out 6 m at most, up to 76°, as a retaining wall or a rock
  cut would), and no road is painted on anything steeper than about 55°.
  Physics stands on the same cut triangles, made in the same decode. A tile is cut as soon as its road
  tiles are in, with the kinds' widths if the exact ones are still on their
  way, and cut again (nearest first, before tiles farther away are loaded)
  where an exact width moves a road's edge by 40 cm or more, or a deck's
  height comes in.
  *Graphics → Quality → Advanced → Terrain under roads*.
- **Tunnels.** The vector tiles mark every road and railway tunnel (a line's
  segments marked tunnel); each detail tile's are found on its decode thread
  (`engine/tunnels/runs.js`), each stretch's ends told apart: a portal where
  the line runs on in the open (or ends at a node any open line meets: 5.17e,
  the Mappo-Morettina tunnel's west portal by Locarno, where a covered 7 m of
  the road outside also ends), a cut at the tile's edge, a node where only
  other tunnel lines meet it (switches, a carriageway joining), a dead end.
  A stretch marked tunnel on a layer over the ground is a covered way above
  it, not a tunnel, and is left out (the covered walks along Bellinzona's
  walls, which 5.17d built as boxes standing on the ground).
  The stretches of the tiles round you are joined across tiles and nodes
  (the straightest way on first, whatever their layer) and gathered into
  bores (`groups.js`): lines of one family running side by side within
  15 m share one, so the Gotthard rail tunnel's two tracks are one tube that
  widens to the four tracks running in at Göschenen's portal, and the two
  carriageways drawn 10 to 14 m apart for the first 400 m inside the
  Gotthard road tunnel are one; twin single-track tubes (17 m and more
  apart) and a motorway's tubes stay apart. A tube that runs on past the
  tiles is followed to its far portal through zoom-13 tiles (`trace.js`,
  a quarter of the bytes): from Göschenen the rail tunnel comes out at
  Airolo after 15,008 m (15,003 m officially) in 6 tiles, the road tunnel
  after 16,906 m (16,942) in 8, kept between sessions. Each portal's floor is
  the road right in front of it (5.17d, his words: "base of tunnel must be
  base of road in front of it (nearest one)"): the ground over the first
  4 m of the road or railway going on from it (which may turn away right at
  the portal), each point taken back to the portal at the rise of the
  ground to 9 m out, their median (a portal mapped a little inside the
  hillside has its face in the first metres: under half of them); where
  most of them stand on the face, the line through the approach's ground
  5 to 24 m out (Siegel's repeated median, which half the points may miss)
  back to the portal; or a bridge's deck where one meets it. At the
  Bellinzona footpath underpass that is the ramp's foot, 2.3 m under the
  line 5.17c took. The floor runs
  straight between the portals, and for the tunnels in the table of the
  longest Swiss tunnels (`sections.js`: lengths, portals and culminations
  from Wikipedia and AlpTransit) climbs to its culmination on the way (the
  Gotthard road tunnel to 1,175 m 8 km in). The road running in is pinned
  to the floor at the portal (`vector/portals.js`, as bridges pin their
  roads to the decks): its profile takes the floor's height there and the
  approach's rise, and eases back onto its own, so its level cut is carved
  into the slope down to the floor with the portal at its end, however far
  the hillside's face rises over it (`wasm/src/shape.c`: a portal's pin is
  always met), and for 6 m out of the portal it is as wide as the tunnel
  to its walls' outer faces (and 0.3 m), narrowing back to its own width by
  12 m, along the road itself
  (5.17e: where a tunnel is wider than its road's cut, a line of sight out
  of it through the lower corners of its mouth runs on under the cut's
  banks and meets nothing; 5.17d's apron, the same width straight out of
  the portal, dug a pocket into a street where the road turned at the
  portal; along the road a more important road it meets keeps its own
  level), and at every portal a 2 m apron runs straight out of it as wide,
  the landing in front of it, pinned to the floor too (where the road turns
  at its portal the widening turns with it, and where no road runs on out
  of it as a line there is none). For 3 m out of a portal its pin holds the
  line at the floor against a junction's height (`shape.c` PORTAL_HOLD: at
  Airolo's farm track box a minor road meeting the track 3 m out pulled its
  first metres up to its own level, 0.6 m over the floor, a step at the
  mouth). Where a more important road's level still holds the ground right
  in front of a portal (a road passing by it), the floor follows the ground
  as drawn there (`tunnels.js` alignPortals, once the ground is cut with
  the roads as they are now). The cross-section comes from
  rules by kind and length, as he asked ("rules + major tunnels table"):
  roads a horseshoe as wide as the road and its walkways (10.5 m, 7 m high
  for a main road), with a flat ventilation ceiling in road tunnels over
  5 km; railways a single-track horseshoe (5 × 6.2 m) that several tracks
  widen (two tracks 3.2 m apart make the Gotthard rail tunnel's 8 × 7 m),
  metre gauge and rack 4.6 × 5.2 m, the base tunnels' bored tubes 7.8 m
  across; tunnels under 100 m cut and cover. Then the ground decides
  (`fit.js`, his words on 5.17b: "just keep terrain without generating
  road"): it is sampled along the tube and each portal's axis and held
  against the floor. A short tunnel (under 300 m, an underpass or a cut and
  cover) must fit under the ground over it, between where each portal's
  ground first has room for the least tunnel of its kind (clearance 4 m for
  main roads, 2.8 m for lesser roads, 2.2 m for paths, 4.6 m for standard-
  gauge railways, 3.6 m for metre gauge): it becomes a box as high as there
  is room for, and where not even that fits it is not built at all, the
  terrain stays whole and the line is not drawn. The tube starts where
  the ground first covers it, its vault, its concrete and 0.2 m of soil, and
  keeps covering them for 4 m (5.17f, his words: "make sure nothing goes
  above the ground"; looked for along the whole tube from each portal, from
  the ground every metre for the first 12 m, every 4 m to 120 m and every
  8 m on); from the mapped portal
  to there the road runs on into the hill in an open cutting at the floor's
  height (`vector/portals.js`: a line of its own as wide as the road's
  widening, its ground pinned to the floor every 2 m, shape.c holding it
  there against any junction's height), so the road, the cutting and the
  tube meet without a step. The cutting ends at the tube's face, and it,
  a portal's landing and a road end square where they meet a portal
  (`wasm/src/shape.c`: at the portal's pin on their line; nothing beyond
  the plane across that end is in their level width or their faces, and
  the terrain's triangles are laid along the end and 0.3 m past it), not
  rounded on into the hill, which laid the ground over a tube's first
  metres flat at the road's height; their other ends round off into the
  ground as any road's do (5.17e started every tube at the mapped portal,
  and its roof and concrete stood out of the ground for its first 2–12 m;
  5.17d started it where the hillside's face was, and the road and the tube
  did not meet). Where a more important road's level reaches over the
  cutting (a road crossing over the tube right at its portal, as the pass
  road over Airolo's farm track box), that road holds the ground there,
  over the vault; checked against the ground as cut (`tunnels.js`
  trimStarts), the tube then starts where the cutting meets that level, so
  no wall stands in front of its mouth. It looks along the cutting's middle,
  0.6 of the way to its walls and out to 0.95 of the way, at most a metre
  apart, and takes the first wall any of them meets (5.17m: a street crossing
  a wide railway box in Bellinzona at a slant held the ground over the vault
  only beyond 0.6 of the way, and it stood as a slab in the side of the
  mouth). Where the ground covers it nowhere
  (after the least box of its kind is tried for a short one: 2.5 m inside
  for a lesser road, 2.0 m for a path), no tube is built and the ground
  stays whole (5.17j; 5.17f dug its cutting the whole way, through the bank
  a low underpass passes under). The terrain's opening at a portal begins
  where the tube does. Where two tubes cross, the one mapped on the lower
  layer (else the one whose floor is lower there) dips under the other, its
  vault, its concrete and 2.5 m of rock below the other's floor, on a
  smooth dip at most 6% steep on average and kept 15 m from its portals
  (`tunnels.js` crossings; 5.17j, his words on 5.17i: "They cross into
  eachother"). Its floor is kept
  under the ground between the
  portals (his words: "if there is a road or something above the tunnel, it
  should not be obstructed in any way ... be underground"): the ground is
  sampled along the whole tube (every 2 m along a short one; along a long
  one every 4 m within 120 m of a portal, every 8 m beyond from tiles of
  zoom 15), and past each portal's mouth (where the ground first leaves room
  for the vault and its cover, at most 30 m in) the floor stays low enough
  for the vault to keep the collar's concrete and some soil (1 m, less over
  a short tunnel) under it: the line between the portals, lowered where the
  ground asks by a taut string under what it asks (the lower convex hull:
  straight stretches of steady grade, no steeper than the kind climbs, eased
  over 10 m), never deeper than a portal lets it dip at that grade. By
  Locarno the Centovallina's tunnel to its station under the town ran level
  from its portal in 5.17d and stood up to 18 m out of the ground over
  1.4 km; it now goes down 23 m in a steady grade under the town. The
  collar's outer side covers the vault where the ground is lower than it,
  near a portal and over a short tunnel all the way, only as thick as the
  ground over it leaves room for (0.4 m under a road over an underpass: the
  road stays  whole). Nothing is built out of the ground. The mesh (`wasm/src/tunnel.c`)
  sweeps it along the tube, a ring wherever the way turns or the bore
  widens (the line smoothed over as much as the bore is wide, so a kink at
  a node does not fold it), with the collar's face and outer side following
  the tube ring by ring, closed where they end in the hill, a threshold at
  each mouth under the floor and the walkways (0.6 m down: the road in
  front lies a hair under the floor, and a line of sight over its edge went
  on under the floor and into the walkways' open ends), a wall where it
  stops, and a dark cap where it runs on beyond what is built. Inside (`shaders/tunnel.wgsl`) no sun reaches: the
  light is the tunnel's own lamps (road tunnels a row of luminaires every
  12 m in the vault, 20 m on lesser roads; railway tunnels dim emergency
  lights every 25 m under the handrail; underpasses bright panels every 4 m;
  a path's tunnel a dim bulb every 30 m) and the daylight falling in at each
  portal. What it looks like goes by what it is for (5.17n, his words on
  5.17m: "make things better and make them more interesting and realistic,
  also account what is road, rail and "by foot""; `tunnels/sections.js`
  lookFor), all of it drawn in the shader from the pixel's metres along,
  across and up: a road tunnel's walls are coated light 3.5 m up (the bare
  concrete over it, a joint every 10 m where it was cast, road spray low on
  them), its floor between the kerbs is its road, asphalt, with markings
  along the tube (5.17p: 5.17o drew them from the data's own lines, which kink
  at their points and crossed where two lines met: his words on 5.17o, "make
  turns and lines smooth", "lanes are messed up and conjunctions too"): edge
  lines 0.4 m in from the kerbs, a solid line on its middle where it is 6 m
  wide or more both ways, one way (the data's `oneway`) its lanes of 3.5 m or
  more dashed apart, 6/12 m where 8 m wide or more, else 3/6 m; none where its
  floor runs on inside another tube (a junction); a drain along each kerb; luminaires'
  housings where its lamps hang (`wasm/src/tunnel.c` luminaires, their
  diffusers lit, their sides in the light their glass spills); guide lights
  every 25 m, and in a tunnel of 300 m or more (ASTRA 74001's scope) an SOS
  niche every 150 m, sides taking turns (an orange door, a lit sign over it),
  an emergency exit every 300 m (a green surround, its door framed in green
  light, the sign over it) and signs to the exits every 50 m; pairs of jet
  fans under the crown every 200 m in a main road's tunnel of 500 m or more
  without a ventilation ceiling (`wasm/src/tunnel.c`). Under a ventilation
  ceiling (a long road tunnel's: the air ducts over it) its exhaust openings
  every 16 m (PIARC 05.16.B: the St. Gotthard's 0.2 m² every 16 m); the slab
  is 0.3 m thick, and where it ends at a portal or where the tube opens into
  another, a bulkhead closes the duct over it (up to 5.17m its open edge and
  the dark duct over it read from outside as a roof floating in the mouth:
  his screenshot of the Mappo–Morettina tunnel by Locarno). A railway
  tunnel's walls are sooty (an older tunnel's masonry, a bored tube's segment
  rings), brake dust low on them; each track lies on ballast or, in a bored
  base tunnel, on a concrete slab: since 5.17q a bed laid where the track
  runs (`wasm/src/tunnel.c` rails: a strip 2.8 m across a hair over the floor,
  drawn by `shaders/vector.wgsl` vtTrack against its own middle: a sleeper
  every 0.6 m, or a block under each rail, the fastenings; up to 5.17p the
  tracks were drawn from the vector tiles' lines, whose straight stretches
  between nodes stood off a curved tube's and crossed at junctions), and
  since 5.17o its rails stand on it (60E1's 172 mm, their heads polished,
  their sides rust brown, flush where a portal's approach goes on). The
  tracks are each line in the bore where it runs (`tunnels/groups.js`
  `lines`: per sample of the spine every line beside it, in order, carried
  by the mesh points; 5.17o knew only the outermost either side and how
  many), each kept 1.5 m in from the kerbs (half a sleeper and 20 cm: his
  words on 5.17p, "make it so that they never touch the walls or sidewalks
  inside of the tunnels"). Since 5.17r each track keeps a place of its own
  from ring to ring (the line's own, then the lines beside it left to right;
  absent where its line does not run), so its rails never break off where
  another line comes or goes; where a line's data ends inside the bore its
  track runs into the nearest track over a turnout (up to 55 m, smoothly), or,
  with none within 6 m, on as it lies to the bore's end if that is within
  40 m (`groups.js`); where the bore is stretched for a line beside it (from
  a switch to where a branch leaves) the walkways are lowered to the floor
  (`tunnel.c` walkway_at, `sections.js` outlineAt for the cut), and every
  track entering a wide portal is pinned to its floor (`vector/portals.js`).
  Since 5.17s a portal's floor is the ground its way runs on outside, not the
  hillside's face over its first metres (`tunnels.js` approachLine: the
  approach's slope held to 5% for a railway, 15% for a road, and of the
  heights carried back at it the lower quarter's; a deck over the approach
  counts only where the way goes on as a bridge: by the 441 m tube's portal
  by Giubiasco a road crossing over it stood the floor on its deck, 8 m over
  the tracks going on), and 20 m out of
  each portal as mapped the ground is drawn as the floor is (ballast and the
  tracks, or the road: the photo showed the real portal's shadow and walls
  there).
  Where a branch opens into a tube, the branch's
  tracks give way in that tube's room, whose own run on to the switch
  (`cuts.js` boreMeets marks the tube a branch's JOIN end lies in;
  `tunnel.wgsl` inMain); the fittings on walls and vault (a handrail, the
  overhead line) give way 25 cm past the other's room (a handrail stood
  across the opening in the hand's width of wall left at its edge). A
  tube's line is a centripetal Catmull-Rom spline
  through its mapped nodes since 5.17q (`groups.js` curveOf: within 2 cm of
  a 400 m arc mapped every 60 m, where the straight stretches between the
  nodes stood up to 1.1 m inside it); a handrail 1 m over each walkway (`tunnel.c` handrails, 5.17p) on
  brackets (TSI SRT: 0.8 to 1.1 m), the cable troughs' lids; in a tunnel of a
  kilometre or more exit signs every 50 m and a cross-passage door every
  500 m (TSI SRT); over each track (the same lines) its overhead line, a rigid
  conductor rail as the Ceneri base tunnel has (Furrer+Frey's ROCS), 5 m up
  (metre gauge 4.4 m) on drop arms from the vault at least 12 m apart, each
  with its insulator over the rail. An underpass
  (footways, steps, cycleways) has tiled walls with a band at hand height, a
  white ceiling of panels, stone paving and a tactile guidance strip; a
  path's or a farm track's the bare rock, wet streaks down it. A collar is
  board-marked concrete, an older railway tunnel's masonry. Where a tube
  starts in from its portal as mapped (where the ground first covers it),
  the open approach between is drawn as its floor (`tunnels/cuts.js`
  addAprons, terrain.wgsl: the tunnel's own roads and tracks on ballast):
  the photo there shows the hillside over the real portal (his words on
  5.17m: "there is still terrain on the track"; by Giubiasco 13.9 m of the
  hillside's green lay across the tracks in front of the Ceneri base
  tunnel's tube). Out of each portal the terrain itself is carved down to the
  floor for 5 m, as wide as the tunnel (`vector/portals.js` APRON, 2 m until
  5.17p; his words on 5.17n: "make it so there is a sort of excavation for a
  couple of meters even when the tunnel is finished"; 5.17o left the ground
  out over the floor there in the shader instead, and the ground being a
  surface with nothing under it, that opened holes). The lamps' light thrown
  back by the floor and walls lights every face a little (no black ceilings).
  The eye adapts to it
  (`workers/render.js` adaptEye, 5.18b): from daylight a tunnel is dark
  inside (its lamps a sixteenth of daylight), and the eye opens up over
  about three seconds (1.2 stops a second, as Unreal's eye adaptation by
  default) and closes again quicker coming out (3 a second). The terrain is cut
  along every tube's whole bore (5.17k): each terrain tile a bore reaches has
  a slot of its own in one uniform buffer made once at the start (96 slots of
  2.5 KB: the tile's frame, how far its pieces reach, and up to 31 pieces, the
  nearest the camera first, put in order again once the camera has moved
  40 m), bound with a dynamic offset as the tile's own data is, and its
  fragments inside the bore (from 0.3 m under its floor, within its walls and
  under its arch, a couple of centimetres more) are left out, so no ground
  stands inside a tunnel or across its entrance, at whatever level of detail
  the tile is drawn. A bore's straight stretches are single pieces (within
  2 cm). 5.17e cut the ground along the bores from a storage buffer of every
  tile's pieces after one another, rewritten and at times made again as it
  grew, and on his GPU (an RTX 2080 Ti) the device was reset from then on (6 s
  after that cut came back when 5.17h's GPU check brought the parts back one
  at a time); if the GPU is reset while this cut is drawn, the next start
  switches it off by itself and says so (Graphics → Diagnostics → *Cut the
  ground along tunnels* switches it on again). After a reset the app starts
  again by itself, the camera where it was, once in five minutes (5.17o: his
  RTX 2080 Ti was reset 2 min 17 s into 5.17n, the frames light, 4 ms; the
  cause is still not known, and every loop a pixel runs is bounded by a
  constant again, as 5.17g had them). Without it (off, or a tile past
  the 96 slots) the ground is opened at the portals only, 5.17d's way: tiles a portal touches are drawn by a third pipeline
  whose fragments inside the tunnel's outline (exactly as drawn: walls to
  the springline, the arch's ellipse over them, bending with the tube, above
  its floor) are left out, from the portal in until the ground is over the
  vault (and at least 12 m: a coarser tile round a steep face lies lower
  than the finest) and never past the tube, so the tunnel shows through the
  hillside's face, the collar covers the edge, and nowhere is the ground
  opened where no tunnel is behind it; a tile takes the two openings nearest
  the camera that reach it. The tiles within 60 m of a portal
  are drawn from both sides: seen from inside a tunnel, or through a short
  one, the ground round its way out (an embankment's slope beside it) is
  met from beneath and shows as the earth it is, dark rock, not as sky (nor
  the photo of a road lying over it, lit from below); and no haze lies over
  it (it is the earth the line of sight runs through, not ground seen across
  the air: from 5.17i to 5.17l it took the sky's blue-grey, a pale wedge
  across a way out). Where tubes run into each other (5.17m, his words on
  5.17l: "count for tunnels merging, or 2 tunnels near eachother and then
  merging"): a branch opening into its main tube, carriageways or tracks
  joining, two tubes side by side that become one. Each tube's mesh is whole
  in itself (walls, floor and vault; an end where it opens into another is
  left open), so where two overlapped each stood inside the other's room: a
  wall across the way into a branch, fins of one's walls in the curve where
  they part. The bores are checked against each other once each time the
  tubes change (`tunnels/cuts.js` boreMeets: pieces within both their reaches
  of each other); a mesh another bore reaches into gets that bore's pieces in
  a slot of its own (a second uniform buffer made once, 24 slots of 2.5 KB
  laid out as the terrain's, `shaders/bore.wgsl`, which both shaders share) and
  is drawn by a second pipeline that leaves out what of it lies inside the
  other bore. Since 5.17n a bore's pieces are its mesh's room exactly
  (`sections.js` outlineAt): beside its floor the walkways stand a kerb high
  and the room starts on them, and a bored tube's lower half is not stretched
  up with a wide bore (5.17m's pieces claimed the room over the walkways, and
  where a branch's wall was left out inside the other's walkway a slit to
  the sky opened low along it, by Giubiasco; 30 cm of slack hid most of it).
  So only 10 cm inside the other's walls and vault (more than a bore's
  pieces stand off its mesh; where two cross, a hand's width of each stands
  past the other, as the edge of the opening), its arch 99% of its size (the
  mesh's arch is a polygon inside the ellipse), and over the other's floor
  or its walkways' top: walls, vault, ceilings and kerbs from 8 cm under it
  where the two floors are at one height, else from 2 cm over it (a branch
  higher than the tube it opens into leaves the vault under its floor
  whole); a walkway's top from 5 cm over it (where two lie at one height both
  stay: a walkway running on into the other tube stops at its edge). Floors
  stay (a branch's floor runs on into the room it opens into; where two
  part, the higher shows, as the lower would show through it as a trench).
  What is left is one room. Since 5.17p an end opening into another tube is
  closed by a cap 5 cm past it, in the other's room, which leaves out what of
  it lies there: what is left closes what neither room does (by Giubiasco,
  where the main tube's walkway starts again past the branch's end, the room
  under it lay open to the distance: his "blue slab"). Tubes nothing
  reaches into are drawn as before, with no discard (it costs every pixel of
  a pipeline its early depth test). A branch's own bore starts 20 m back
  inside the one it leaves (`tunnels/groups.js` JOIN_INTO: it leaves where its
  line is 20 m off the spine, and the bore's reach, held and smoothed along,
  fell 3.4 m short of it there, so its open end stood mostly outside the
  room it opens into, a hole to the rock and the sky behind: by Giubiasco it
  read as a second mouth, with the ground seen from beneath across it), and
  its floor runs to the floor of the one it opens into (`tunnels.js`
  #joinedFloor: from one portal it was level at that portal's height, there
  6 m over the other's; what the fit still leaves between them is eased away
  over 40 m). Walking and flying go from one into the other: where a point is
  in two bores, the one it is furthest inside answers (`tunnels.js` boreAt),
  so the other's walls do not hold you where it opens; and the whole room is
  seen as inside (no outdoor haze on the other tube). A
  tube is culled by a sphere round all of its points (5.17e: 5.17d's was round its
  middle point, half its length: a bent tube lost its far end at some
  angles). What is built is cut
  away along every tube (5.17d, his words: "it should be able to traverse
  building walls (like the underground castle wall)"): each tube's bore,
  as chains of points along its middle with its outline (`tunnels/cuts.js`),
  goes to the buildings' pass, and a building tile a bore reaches is drawn
  by a second pipeline that leaves out whatever lies inside it
  (`shaders/buildings.wgsl` fsCut), so the railway's tunnel under
  Bellinzona's castle wall runs through it; only those tiles pay for the
  discard. Flying, walking and the airplane go in (5.18b,
  `controllers/fly.js`, `walk.js`, `plane.js`, `tunnels/bore.js`): inside a
  tunnel its floor holds you up instead of the hillside over it (a walkway
  a kerb higher), its walls and vault keep you inside (the airplane's wing
  against a wall is a crash), and there the buildings' solids neither hold
  you up nor stop you, as they are not drawn. A step into a tunnel is
  judged by its floor, not by the hillside over it (5.17e, his words: "I
  still cannot walk in them ... an invisible wall": 5.17d judged it by the
  slope of the hillside's face, too steep to walk up, and its tubes started
  inside their portals, so you stopped 0.1 to 1.4 m in front of 10 of the 14
  portals at his places; now you walk into all of them). *Layers →
  Tunnels*.
- **Sky, light and haze.** One model of the air
  (`shaders/atmosphere.wgsl`, Sébastien Hillaire's method from EGSR 2020, as
  Unreal Engine uses): Rayleigh scattering for the blue, Mie scattering for
  haze and the glow round the sun, ozone, over a round earth. Small tables
  made by compute passes (`js/engine/passes/atmosphere.js`) stand in for the
  integrals: how much light survives a path through the air and the light
  scattered more than once, made once; the sky around the camera, redone
  when its height changes; and the haze between the eye and everything in
  view, a 32 × 32 × 32 grid over the screen, every frame. The same model
  gives the sunlight and skylight everything is lit by, at the ground under
  you, so a wall facing away from the sun is lit by the blue sky and the
  ground, and distant mountains fade into the right blue. Together a
  fraction of a millisecond.
- **Colour.** Shading happens in linear light and is encoded to sRGB once, at
  output. Exposure is set so that level ground in full sun comes to 1, and
  the tone curve passes everything below 0.8 through untouched and rolls
  brighter light off to white, so aerial photographs come out exactly as
  photographed while the sun and its glare on glass do not clip harshly.
- **Physics.** Flying and walking are separate controllers stepping at 120 Hz on
  the render thread. Walking stands on the terrain's own triangles through a
  grid index the C core builds for the finest tiles around you, including the
  ones behind you that are not drawn; a lookup costs about 0.05 µs. Only
  accurate tiles are indexed (level 14 and finer, or the finest there is),
  so a coarse stand-in never becomes a floor. Buildings
  and bridges collide through the same kind of grid, built by the C core on
  the decode threads over exactly the triangles that are drawn
  (`wasm/src/solid.c`). Around you the streamers load every tile in full
  detail whether or not it is on screen, tiles near the camera keep a CPU copy
  of their triangles, and each frame the few within reach are gathered into
  one short list that every physics step asks: the highest surface to stand
  on, the lowest one overhead, and how far an upright body 30 cm in radius is
  pushed out of the walls it overlaps (`js/engine/features/solid.js`). A wall
  counts only for the part of it beside the body (each triangle is clipped to
  the body's footprint first), so the side of a rising bridge, one long
  triangle spanning a hundred metres of height, is solid only where it is
  drawn; and the grid files each triangle only in the
  cells it actually crosses, not every cell of its bounding box. Moves
  are swept in steps shorter than the body, so speed cannot tunnel through a
  wall. Whether a spot is inside a building is decided the way it is for any
  closed shape, by counting the surfaces straight above it: odd is inside,
  even is outside or under a bridge.
- **Interface.** Search with live suggestions, a settings menu with a tab per
  subject (General, Graphics, Layers, Character, Physics, Vehicles, Controls, World)
  and a page per topic in a column beside it (Graphics: Quality, Display,
  Loading, Diagnostics; Vehicles: Airplane, with trains and cars to come),
  generated from one schema, and an instrument readout in metric or imperial.
  A page can have presets (Graphics → Quality: Low, Medium, High, Ultra;
  Vehicles → Airplane: Easy, Realistic), lit up while the settings match one,
  and Custom when they do not; its finer settings fold away under *Advanced*,
  which stays open or closed as you left it. Switches say On and Off, sliders
  show their value with its unit, a setting changed from its default gets a
  reset button, and each page can be reset.

## Layout

    index.html
    css/ui.css
    files.json                   every file the app loads, revalidated by index.html before start
    js/build.js                  the build number every thread reports
    js/main.js                   page thread: boot, UI wiring, nothing per frame
    js/core/rpc.js               the message protocol every thread speaks, with cancellation
    js/core/workers.js           blob spawning, load-balanced dispatch, pools that resize
    js/core/scheduler.js         whose turn it is on the decode threads
    js/core/net.js               what a service's answer means: nothing there, try again, the file
    js/core/buffer-pool.js       result buffers that go back to the decode threads to be filled again
    js/core/wasm.js              compile once, instantiate per thread
    js/core/math.js              f64 geodesy, ellipsoid radii, Mercator, reverse-Z
    js/core/settings.js          the schema that drives the settings menu, and the key actions
    js/core/signal.js            small tools for sampled curves: running maximum, slope limit, blur
    js/core/geo.js               offsets on the ellipsoid, a flat map centred anywhere (azimuthal
                                 equidistant) to plan in
    js/core/session.js           where you were, for resuming there
    js/core/input.js             keys, mouse, double-tap, browser shortcut capture
    js/adapters/adapter.js       the contract a data source plugs into
    js/adapters/registry.js      which source serves which area, per tile
    js/adapters/index.js         every registered source
    js/adapters/swisstopo.js     Switzerland
    js/adapters/swisstopo-buildings.js  what Swiss buildings look like: regions, palettes, looks, rules
    js/adapters/open-meteo.js    worldwide place names for Global search
    js/adapters/swisstopo-transport.js  the vector tiles' road and rail classes, and what each is drawn as
    js/engine/gpu.js             device negotiation, capabilities, GPU timing
    js/engine/frame.js           render targets, resize, the loop
    js/engine/journal.js         what was made and destroyed on the GPU lately, for a reset's report
    js/engine/autoscale.js       the render scale kept to a frame rate
    js/engine/uploads.js         the per-frame upload budget
    js/engine/profiler.js        where each frame's time goes
    js/engine/lru.js             least-recently-used order without sorting, for every tile cache
    js/engine/topk.js            the few most urgent of many candidates, for every request queue
    js/engine/camera.js          position and view; controllers move it
    js/engine/view.js            what the camera sees this frame: frustum, distances, horizon
    js/engine/bounds.js          bounding spheres for regions, boxes and spheres
    js/engine/controllers/       fly.js, walk.js and plane.js (the airplane mode)
    js/engine/aircraft/          atmosphere.js (the standard atmosphere) and jet.js (the
                                 jet's airframe, engine and fly-by-wire)
    js/engine/flight/            the search flight: route.js (seen from above), profile.js (from
                                 the side), timing.js (its pace), plan.js (all of it, worked out
                                 before it starts), obstacles.js (what it keeps clear of),
                                 flight.js (flying it, late moves of its end, the wait, landing)
    js/engine/terrain/           the quadtree, layer.json and availability, ground lookup
    js/engine/features/          the 3D Tiles streamer, the collision world, building looks
                                 (appearance.js), their shared GPU records (feature-pool.js),
                                 bridge decks' heights (decks.js)
    js/engine/material-library.js  the wall materials, drawn on the GPU at start-up
    js/engine/imagery/           the clipmap, its source, Web Mercator in doubles
    js/engine/vector/            vector tiles: the service (source.js), the tiles round the
                                 camera, their page tables and exact widths (tiles.js), one GPU
                                 buffer handed out in pieces (pool.js), the pieces cut into the
                                 terrain (pieces.js), roads joined to bridge decks (bridges.js)
                                 and pinned to tunnels' floors (portals.js)
    js/engine/tunnels/           tunnels: a tile's tunnel runs (runs.js), runs into tubes
                                 (groups.js), a tube followed to its portals (trace.js), cross-
                                 sections, the table and the floor (sections.js), a tube fitted
                                 to the ground and kept under it (fit.js), a tube's mesh points
                                 (mesh.js), the room it takes out of what is built (cuts.js),
                                 what the
                                 controllers ask of a bore (bore.js), all of it on the render
                                 thread (tunnels.js)
    js/engine/passes/            one file per pass: the atmosphere's compute passes, sky,
                                 terrain, tunnels, buildings, cables, a flight's path and its
                                 destination's name (label.js); and the shared frame uniforms
    js/engine/shaders.js         joins WGSL files, maps errors back to them
    js/engine/shaders/           common (output), atmosphere and atmosphere-luts (the air),
                                 frame (light, haze), imagery, vector (roads and rails
                                 under a pixel), terrain, tunnel, bore (the tunnels' bores
                                 as slots of pieces: the terrain's cut, tubes meeting),
                                 buildings, materials, sky, cables, path, label
    js/formats/                  b3dm, glTF, Draco and meshopt loading, tile content,
                                 lines.js (lines a source models as tubes back to lines),
                                 tops.js (a tile's grid of highest points), decks.js (the tops
                                 of a bridge layer's decks) and
                                 tileset-index.js (tileset files as compact indexes),
                                 vector-tile.js (a vector tile into a block the GPU searches),
                                 road-widths.js (each road's own width from the landscape model)
    js/workers/render.js         the render thread: device, camera, physics
    js/workers/codec.js          a decode thread
    js/workers/index-cache.js    tileset indexes kept in IndexedDB
    js/ui/                       boot, readout, search, the settings menu, the performance panel,
                                 cockpit.js (the airplane's head-up display)
    vendor/                      the Draco and meshopt decoders, with their licences
    wasm/core.wasm               prebuilt, committed
    wasm/src/core.h, core.c      shared declarations, the arena
    wasm/src/mathf.c             sin, cos and geodetic-to-ECEF without libm
    wasm/src/qm.h, qm.c          Quantized Mesh parser and render decoder
    wasm/src/ground.c            the triangle grid physics stands on
    wasm/src/mesh.c              building meshes: placement, 12-byte packing, measurements
    wasm/src/solid.c             the triangle grid buildings collide through
    wasm/src/bc.c                BC7 and BC1 encoders for the aerial photos
    wasm/src/mvt.c               vector tiles: roads and rails into lines and a grid
    wasm/src/shape.c             roads, tracks, paths and railway beds cut into a terrain tile
    wasm/src/tunnel.c            a tunnel's inside as a mesh: its cross-section swept along it
    wasm/build.sh                only needed if you edit the C
    wasm/test.mjs                node wasm/test.mjs
    tools/                       the verification rig, never loaded by the app; fixtures/
                                 holds real tiles the tests decode

## Rebuilding the wasm

You do not need to. If you edit anything under `wasm/src/`:

    sudo apt install clang lld && npm i -g binaryen
    ./wasm/build.sh

## Verification

`tools/` is never loaded by the app. `tools/verify.mjs` runs the real page in
Chromium on a software GPU (SwiftShader), answers every swisstopo request from
`tools/mock-data.mjs` with synthetic but valid Quantized Mesh tiles, and fails
on any WebGPU validation error, uncaught exception or failed module load:

    xvfb-run -a node tools/verify.mjs --shot frame.png
    xvfb-run -a node tools/verify.mjs --scenario buildings --settings '{"renderScale":0.5}' --shot b.png
    xvfb-run -a node tools/verify.mjs --scenario lod --settings '{"renderScale":0.5}' --shot lod.png
    xvfb-run -a node tools/verify.mjs --scenario walk --settings '{"renderScale":0.25}'
    xvfb-run -a node tools/verify.mjs --scenario collide --settings '{"renderScale":0.35}' --shot c.png
    xvfb-run -a node tools/verify.mjs --scenario tower                # a 205 m tower is solid 180 m up
    xvfb-run -a node tools/verify.mjs --scenario imagery --settings '{"renderScale":0.5}' --shot im.png
    xvfb-run -a node tools/verify.mjs --scenario perf --settings '{"renderScale":0.35}'
    xvfb-run -a node tools/verify.mjs --scenario stress --settings '{"renderScale":0.25}'
    xvfb-run -a node tools/verify.mjs --scenario stream --settings '{"renderScale":0.35}'
    xvfb-run -a node tools/verify.mjs --scenario ui --settings '{"renderScale":0.5}' --shot ui.png
    xvfb-run -a node tools/verify.mjs --scenario flight --settings '{"renderScale":0.35}'
    xvfb-run -a node tools/verify.mjs --scenario flightlook --shot fl.png
    xvfb-run -a node tools/verify.mjs --scenario look --settings '{"renderScale":0.5}' --shot look.png
    node tools/flight-test.mjs --count 2000                    # the search flight, without a browser
    node tools/walk-test.mjs                                   # walking by Minecraft's rules, sneaking and its edges, the body's drag against the drag equation and people's, vertical momentum into walking
    node tools/plane-test.mjs                                  # the airplane: performance, stall speeds, the pull and the view, the engine off, the stall, a glide, loop, landing, crash, the display through rolls and loops, the wheel, the roll and the pull against the speed, the drag in climbs and dives, the throttle
    node tools/autoscale-test.mjs                               # the render scale kept to a frame rate, with a simulated GPU
    xvfb-run -a node tools/verify.mjs --scenario plane --shot p.png   # the airplane in the app, its head-up display
    xvfb-run -a node tools/bc-test.mjs
    xvfb-run -a node tools/fresh-test.mjs                     # an update runs the new files
    node tools/manifest.mjs                                   # before a delivery: files.json, build number
    node --expose-gc tools/bench-streaming.mjs --frames 6000 --worst 10
    xvfb-run -a node tools/live-tour.mjs --seconds 90        # needs the network
    xvfb-run -a node tools/live-tour.mjs --seconds 30 --threads 8 --flights "8.9511,46.0037" [--walk]
    xvfb-run -a node tools/live-tour.mjs --plane --seconds 480 --threads 8 [--plane-low 250]   # the airplane, scripted
    xvfb-run -a node tools/live-startup.mjs --seconds 30     # needs the network
    xvfb-run -a node tools/verify.mjs --scenario vector --shot v.png   # roads and rails from stand-in vector tiles
    xvfb-run -a node tools/live-roads.mjs --place zurich --shot r.png  # the live vector tiles, and the data view
    xvfb-run -a node tools/verify.mjs --scenario tunnels --shot t.png # the stand-in railway tunnel: tube, portals, inside
    xvfb-run -a node tools/live-tunnels.mjs --shot gt.png             # the Gotthard tunnels at Göschenen, live

The buildings scenario serves a small stand-in town the way swissBUILDINGS3D
is organised (`tools/mock-buildings.mjs`): nested tilesets, coarse boxes
replaced by gabled houses, the detailed tiles spread over plain, meshopt and
Draco glTF, one house per tile marked underground. It checks that every tile
drawn holds exactly its houses' triangles less the underground one, that
detailed tiles replace coarse ones up close, that the layer switch works, and
that the tileset files are indexed on the decode threads and, after a reload,
read from IndexedDB rather than downloaded again;
the stand-in photos show the houses' roofs, so the screenshots show at a
glance whether the roof texturing lines up. The rig needs the encoders once:
`npm i -g draco3dgltf meshoptimizer`.

The lod scenario checks the terrain quadtree against its own rules: the tile
under the eye is exactly as fine as the pixel budget asks, detail falls off
with distance, looking away draws less, nothing is requested that the tiles'
availability metadata says does not exist, a search pick lands you standing on
level 18 where the stand-in service has it and on 17 where it does not, New
York is reached in flight with a notice and with nothing drawn or fetched past
the horizon, imagery still works on the way back, and a small memory budget
is kept. `--session '{json}'` seeds the saved camera, for testing a resume.

The walk scenario takes the pointer, double-taps Space, walks, runs, jumps,
bounces with Space held, slides off a slope it cannot climb, flies up and
falls back down, and checks each against the physics, measured on the
simulation's own clock.

The collide scenario uses the stand-in town and a stand-in bridge leaving a
ridge over the falling slope. It walks into a house wall and checks it stopped
a body's radius short, walks at it at 45° and checks it slid along, arrives
inside a house and checks it was put outside, drops onto a tower's roof and
stands there, walks out along the bridge deck with the ground falling away,
flies into a wall and stops, then with *Fly through buildings* on, does not.
Then a cable car, modelled as swissTLM3D models one (a 1 m tube whose sides
run the whole span, 40° then 15° up, with a ball at the mast): it is drawn as
a rope with its exact number of pieces and one pylon, and no tube; flying
under it, level with it and over it all pass. It also screenshots a facade
close up and the bridge from the side.

The imagery scenario serves synthetic aerial photos drawn from the same height
field as the terrain, with a line every 0.01°, so misplaced imagery is obvious
in its screenshots. It checks the sharpest level against the arithmetic, that
blank placeholder tiles are refused, and that a zoom the service does not have
is switched off after a few refusals instead of being requested forever.

The perf scenario flies low over the stand-in town while everything streams
and prints where each frame's time went, section by section, with the 95th
percentile and the worst frame of each; it checks that uploads stayed inside
their slice.

The stress scenario gives terrain and buildings a fraction of the memory the
view needs and flies over the town turning, the situation that used to scan
and sort every loaded tile each frame. It checks that memory stays within the
budgets (detail is lowered instead), that dropping tiles and housekeeping stay
cheap frame after frame, that detail comes back once there is room, that
pausing streaming stops new requests and resuming picks up again, and that the
decode jobs out never exceed the scheduler's capacity.

The stream scenario makes the stand-in services misbehave (`faults` in
`verify.mjs`) and checks the loading rules: a server error is tried again a
moment later and loads; a 429 with Retry-After: 2 is tried again no sooner,
and halves the host's share of requests, which then recovers; an answer that
never comes is given up at the job's timeout and asked for again; requests
for what the view has left are called off; everything loads once the
services behave; nothing the services said is not there is ever asked for
twice; the jobs out never exceed the capacity; and with eight decode
threads and photos answering slowly, a search flight's photos prepared ahead
go out with their share of the slots without upsetting the checks for stale
requests.

The ui scenario works the settings menu like a person: opens it, switches
tabs, sets a choice and a distance slider and checks the renderer obeyed,
resets, flips a switch, binds Move forward to another key and walks with it,
closes it with Esc. Then the mouse: E frees it and keeps fullscreen, E takes it
back, and with it free Esc leaves fullscreen; O opens the menu, freeing the
mouse and keeping fullscreen. Then it searches through the real search box
(the rig answers for both search services) and picks results: the pick takes
the mouse back; the flight sets off within 2° of the camera's heading with
the view not turning, leaving level from the air and curving up, draws its path with beads and the
place's name over it, looks the way it goes, banks into its turns within the
setting (and never against them), stays level in flight and never turns
faster than the limit, stays well clear of the ground, comes in within 1° of
the start heading and arrives facing exactly that way, tilted as it was,
level, at the same height above the ground; with *Fly to search results*
off, it is there at once; *Longest flight* at its shortest, 5 s, caps a long
flight's plan to 5 s; a
150 m trip straight ahead from 300 m up flies one arc straight there, quickly,
the view kept (neither turning, tilting nor banking); walking, a pick of an address in the middle of a house lands you on open
ground beside it, walking, never into the house on the way (more than a metre
above its roof wherever it passes over it), and again after walking a couple
of metres away from it and picking it again, with the flight on and off;
flying 5 m up, the same pick ends 5 m up, outside the house. `wasm/test.mjs` also
decodes the stand-in cable car through the tile decoder and checks the rope,
its sag and the pylon against the model, and a real swissTLM3D tile
(`tools/fixtures/tlm-gorduno.b3dm`, Draco-compressed, saved from the live
service) whose ropeway must come out as 114 rope pieces through its masts at
the heights measured from the tube, with its bridges kept.

`tools/flight-test.mjs` checks the search flight without a browser. It plans
flights through stand-in worlds whose heights are known exactly (a height
field with a pyramid of maxima, boxes for buildings, straight ropes), plays
each back at 500 Hz and checks that it never comes within a metre of
anything, starts and ends exactly where and how it should, at rest; that the
view looks within a degree of the way it moves; that neither its path nor its
view turns faster than 20° a second, nor the turning changes faster than 15°
a second each second (a little over, measured between samples), both times
how much faster *Longest flight* plays it; that a hop does not turn the
view at all; that every trip is the kind its distance asks for (a hop, the
view kept, under 300 m, an S from there on); that the view tilts no faster
than 25° a second at the flight's own pace, or the flight is 1.5 times
longer for it (in the open: a walker 2 km and 5 km off, flying 100 m and
300 m up, 20 km away; and every random S); that its flown path passes its own
check before it flies (every one of them, none planned again in the stand-in
worlds); that it leaves the way it faces in the open, turns its back on a
wall 3 m ahead to climb at 60°, and leaves along a street rather than up its
walls; that it is never paced faster than the trip allows, never banks
more than the setting, never jumps, never takes longer than *Longest flight*
nor less than 3 s: named cases from the sketches the flight was drawn from (a
hop of 10 m to the side glides there under 6 m up in 3 s; 10 m behind, 1 m
ahead, 40 m behind with two slow U-turns, past a building, beside one, across
the Mischabel, under a cable car; over flat ground, the pace measured from
the positions is one bell, fastest at 50% of the time, and the progress is
exactly the minimum-jerk curve), then 2,000 random flights from a metre to
500 km. It also checks the app's own bounds through their code (a tile's grid
of highest points against the triangles and ropes it was made from, the
terrain's bound over a tree of tiles, some not loaded, and a building layer's
over a tileset, loaded and not) and flies the runtime with a real camera: a
landing spot known at once, found on the way, found 6 s, 3.5 s and 1.5 s
before the end (down onto it on the way; over the place first, then down, as
its way down would drop faster than the flight's pace), never found (over the
place, then left there flying); a hop and a longer landing where only coarse
bounds are known round the place (over the place first, then down; down on
the way at its pace); better ground found on the way and on the way down; a
place slow to load; *Longest flight* 4 s; landing spots 1.6 m from a house
(found on the way, and while over it) and beside a 150 m tower (over it, all
the way across before coming down); a tower that only becomes known on the
way (risen over, 93 m over its roof) and nothing new on the way (never
nudged); another place picked while climbing, in the cruise, coming down and
coming down to land beside a house (arriving as the first flight would have,
at the speed it had). Each arrives exactly, never comes within a metre of
anything, nor of the house, no frame jumps, it never comes down faster than
three times the flight's peak pace (in heights a second over the ground, as
played), its clock is the time flown (it keeps its pace), and after a new
pick it keeps its speed and the view turns smoothly.

The flight scenario starts in basins of the stand-in terrain far from anything
loaded, where the coarse tiles that arrive first are far above the floor, as
over the Alps. Placed low with no key held, the camera must not move while the
terrain streams in; physics must only use accurate levels; flying at 250 m/s
40 m over ground that has not loaded, the camera may only rise onto accurate
ground, and the columns ahead must have been requested; a walker placed over
unloaded ground waits and then drops onto the accurate ground, and running
backwards from there, away from everything the view has loaded, never meets
an edge; a walker high above everything falls at once.

The look scenario measures nothing: it saves screenshots of the stand-in
town from the street, from arm's length, from above a row and from a
hillside, and of the cable car from beside it, for judging the walls, the
light, the sky and the ropes by eye. The flightlook scenario does the same
for a search flight: from 300 m over the town, facing away from the place,
screenshots as it rises (the place off the screen, marked by the arrow at its
edge), turns, flies on and comes down, for judging its path and the place's
name by eye (it checks only that both were drawn and that the flight
arrived). The tower scenario flies level into the stand-in town's 205 m tower
180 m above its foot, higher than physics used to touch the world, and
checks it stops at the wall.

The vector scenario serves stand-in vector tiles (`tools/mock-vector.mjs`:
real Mapbox Vector Tiles of a made-up network round the stand-in town, a
street grid cut at every junction, a tram, a railway with a tunnel and a
bridge, a motorway, every third tile gzipped without saying so). It checks
that nothing loads from high up, that both zooms load over the town and only
they are asked for, that every tile lands in the page tables within the
memory setting, that each road gets its own width from a stand-in
identify service, that the terrain is cut under the roads and physics
stands level across a street on a slope, that the roads are drawn on the
ground and on a bridge's deck (pixels that change with *Layers → Roads*, and
what they cost the terrain pass on a software GPU): over a street the photo
shows, the photo itself (the colour all but unchanged with the roads off),
and under the stand-in's tree crowns a road made instead; that a road coming
off the stand-in bridge starts at its deck's height, and the road under the
deck's far end, 86 m up, stays on its own ground; that the data view
draws the streets, the tram and the railway in their colours (counted in the
screenshots), that a new memory setting refills a new buffer and a shorter
distance asks for less.
`live-roads.mjs` does the same against the live service at Zürich HB,
Bellinzona or the Gotthard rail tunnel's portal at Göschenen and prints what
it cost: the road tiles, the exact widths (calls, megabytes, segments
matched), the terrain cut round you (tiles, triangles added, time) and, with
`--structures`, the road ends joined to bridge decks; `--timeline` prints
once a second how far the road tiles, the widths and the cutting have got.
`wasm/test.mjs` cuts a road into a stand-in 30% hillside and the real roads
into a real terrain tile under Göschenen (the roads level across after, the
surface closed, physics on the drawn triangles, the faces marked, a deck's
pin held and eased back, the distances along every line in step), and
matches the real widths of Göschenen's tile from a saved identify answer.

The tunnels scenario stands outside the stand-in railway's 1.5 km
double-track tunnel: one tube for both tracks, both ends portals, each
portal's floor the ground of its approach fitted back to it, the mesh built
and drawn, the terrain tiles at the portals drawn with the opening; every tube starts at
its mapped portal and stays under the ground past its mouths; the portal's
pixels change with *Layers → Tunnels*; from 300 m inside, flying, the camera
is in the tube and sees walls and lamps, no sky; inside, the eye adapts to
the dark and back to daylight at its rates.
`live-tunnels.mjs` goes to Göschenen against the live services, waits until
the Gotthard rail and road tunnels are found, followed to Airolo and built,
prints every tube (its length, the whole tunnel's, its ends, its floor at
both ends, its cross-section) and the portals, and looks at each portal from
60 m outside and from 40 m inside. `wasm/test.mjs` finds the stand-in
tunnel's tube and Göschenen's tunnels in the real tile, checks the
cross-sections turn the right way, the Gotthard road tunnel's floor through
its culmination, and a mesh: every triangle facing the way it should, the
floor at its height, the collar there; per end, the collar out of its portal
by as much as asked and its outer side back along the tube to where it is
closed, no wing walls where none are asked for; and the fit on made-up
ground: a 17 m minor road under a 5 m embankment becomes a 4.4 m box from
its mapped portal with concrete 0.4 m thick over it, a stretch under 1 m of
ground is not built, a long tunnel's portal in a hillside rising 1 in 2 has
its face 4 m in; a railway tunnel whose line runs 3 m under a valley dips
under it in steady grades (its vault at least 1 m under the ground, never
steeper than 4%), one running into a town to a dead end goes down under the
town, and a culmination is kept. `walk-test.mjs` walks into a tunnel at the
foot of a hillside rising 3 in 1 from its portal (5.17d stopped there), and
from a tunnel into a branch joining it (5.17m; up to 5.17l the tunnel's wall
held you at 3.7 m). Tubes running into each other (5.17m): of a main tube, a
branch leaving it, a twin 40 m off, two tubes side by side 6 m apart and a
branch 6 m higher, only those running into each other meet, and as the
shaders' test has it the main's wall where the branch opens is left out and
its far wall kept, the branch's walls and vault inside the main left out,
the floors kept, and the vault under the higher branch's floor kept (no
slit); a branch leaving a bore at 5° ends
inside the room it opens into (18.3 m off the main's line, its reach there
18.8 m; up to 5.17l 20.0 m against 16.6); and a wide box under a street
crossing it at a slant starts at its portal (up to 5.17l 3 m in, the
street's ground a slab in its mouth). With walkways (5.17n): a branch's kerb
standing inside the main's walkway is kept (5.17m left it out: the slit), its
walkway's top over the main's floor left out, over the main's walkway kept;
and a bored tube twice as wide is not taken for room 7 m across and 2 m
under its arch's middle (its lower half is not stretched up). The mesh
(5.17n): a ventilation ceiling's underside faces down at 5 m and its top up
0.3 m over it, a bulkhead closes the duct at the portal; a railway's
conductor rail hangs over each track with its contact wire 5 m up and its
drop arms up to the vault; a main road's jet fans hang in pairs over the
road's 4.6 m clearance; and a footway's tunnel looks like an underpass, a
path's like the rock, a railway's and a one-way motorway's as they are.
(5.17o) A railway tube's rails stand 0.172 m over its floor, flush at its
portals; where a branch runs beside the main tube, the main's lines say 2 side
by side, the outermost 19.9 m off at the most. (5.17p) A road tube's
luminaires' housings every 12 m, their diffusers facing down; a railway tube's
handrail along both walls.

`bc-test.mjs` runs the C encoders on test images, lets the GPU's own decoder
read the blocks back, and compares with the source and with a naive BC1
encoder put through the same decoder; BC7 has to beat BC1 clearly. A layout
mistake would show as garbage, not a small error.

`fresh-test.mjs` serves a copy of the app the way some local servers do (an
old Last-Modified and no Cache-Control, which lets the browser reuse its
copies for days), changes the build number in it as an update does, reloads,
and checks that every thread runs the new files; with the plain module tag
older builds had, the same reload must run stale copies, or the test would
prove nothing.

`bench-streaming.mjs` runs in Node, without a browser: the app's own terrain
and 3D Tiles streamers against the stand-in terrain and the real
swissBUILDINGS3D tileset tree, with a fake GPU and decode pool, timing only
what the render thread does per frame to decide what to draw, load and drop,
and what it does with arriving results. Time runs on a simulated clock of 120
frames a second. A first, untimed flight makes the stand-in tiles, whose
garbage would otherwise land in the timed frames; tileset files are indexed
on a thread of their own, as the decode threads do in the app; result buffers
go round as they do in the app. `--root` points it at another copy of the
app, to compare two versions; `--worst N` lists the slowest frames section
by section.

`live-tour.mjs` and `live-startup.mjs` use the real services. The tour runs
the app against swisstopo at Bellinzona with small memory budgets, flies a
turning tour at 150 m/s and prints the render thread's cost per section every
ten seconds. `--threads` sets the decode threads, `--flights` first flies to
each place as a search pick does (real latency, preloading and all) and
`--walk` makes those flights land walking; every delivery is run this way
too, since the stand-in answers instantly and cannot show what real latency
does. `--plane` flies the airplane instead, a scripted pilot climbing from
1,200 m over the Magadino plain; with `--plane-low` it starts that many
metres over Bellinzona's floor and flies on level, so its collision focus
four seconds ahead loads round the town (its radius is printed). The startup check starts flying at 330 m in the valley at
Bellinzona, holds no key, and prints the camera's height as the terrain
streams in; it fails if the camera rose (before the accurate-ground rule it was
lifted to 3,286 m). Both take `--root` for comparing two versions.

The frame rate it reports is a CPU rasterizer's, not your GPU's, and the
terrain is synthetic. What it proves is that every pipeline, buffer and shader
is valid before a change ships.

## Data

Map data comes from the Swiss Federal Spatial Data Infrastructure and is
subject to its [terms of use](https://www.geo.admin.ch/en/general-terms-of-use-fsdi).
Worldwide place names come from GeoNames through Open-Meteo, under CC BY 4.0.
The two third-party decoders under `vendor/` (Draco, Apache 2.0; meshoptimizer,
MIT) are listed with their sources in `vendor/README.md`.

| What | Service |
| --- | --- |
| Terrain | Quantized Mesh from swissALTI3D, levels 0–18 with normals and availability, `3d.geo.admin.ch`, located through its `layer.json` |
| Imagery | SWISSIMAGE via WMTS, `wmts.geo.admin.ch` |
| Buildings | swissBUILDINGS3D as 3D Tiles (b3dm), `3d.geo.admin.ch` |
| Bridges and structures | swissTLM3D 3D objects as 3D Tiles (b3dm), `3d.geo.admin.ch` |
| Roads and railways | the vector base map `ch.swisstopo.base.vt` (Mapbox Vector Tiles, zooms 13 and 14), `vectortiles0`–`4.geo.admin.ch`, located through its TileJSON |
| Road widths | swissTLM3D's roads (`ch.swisstopo.swisstlm3d-strassen`) through the identify service, `api3.geo.admin.ch`, near you only |
| Trees, names | 3D Tiles, `3d.geo.admin.ch`, declared for the steps that draw them |
| Place search, National | SearchServer, `api3.geo.admin.ch` |
| Place search, Global | Open-Meteo geocoding over GeoNames, no key, free tier limited to 10,000 calls a day |
