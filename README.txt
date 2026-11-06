RICOCHET ARENA
First-person tank battles on a freshly generated arena every round.
Play solo against bots, or online with up to 8 tanks (friends plus bots).


HOW TO START
  Double-click Play.bat. A small local web server starts and your browser opens the game.
  Keep the black server window open while you play; close it when you're done.
  (Browsers refuse to load 3D models and sounds from a page opened straight from disk,
  which is why the game needs the little server.)


CONTROLS
  Mouse ............ turn the turret and look (click the game once to capture the mouse)
  W A S D .......... drive. By default the tank drives toward where you look;
                     switch to "Classic tank" in Settings for A/D hull turning
  Left click / F ... fire a shell
  Space / E ........ drop a mine
  Right click ...... zoom the sight
  T ................ aim line on or off (shows the shell path and its first bounce)
  Arrow keys ....... turn the turret without the mouse
  Enter ............ chat (multiplayer)
  Tab (hold) ....... scoreboard (multiplayer)
  H ................ show the controls during a match
  Esc .............. pause menu (in multiplayer the match keeps running)


RULES
  Shells ricochet off walls and then break. Your own shells can kill you after a bounce.
  Two shells that meet cancel each other out, so you can shoot incoming shells down.
  Mines explode after 10 seconds, when an enemy drives close, or when a shell hits them.
  Mine blasts destroy tanks, nearby shells and the green crate stacks.
  Concrete blocks and low walls stop shells and tanks. Low walls are short enough to see over.
  Steel tank traps stop tanks, but shells fly straight over them.


SOLO MODES
  Duel ...... pick the bot's difficulty (Recruit, Regular, Veteran, Ace). First to 5 rounds wins.
  Gauntlet .. every level brings a different, tougher bot. You have three lives.
  Arena size  Small, Medium, Large or Huge. The menu's background previews the size.


PLAYING WITH FRIENDS
  Click "Play with friends", pick a callsign and a tank colour, then either:
    Create lobby ... you become the host and get a 4-character code (for example K7QX)
    Join lobby ..... type a friend's code
  In the lobby: everyone sees the player list and the chat. Players press Ready.
  The host sets the match rules and presses Start match.

  The host's game runs the match. If the host leaves, the match ends for everyone.
  Minimising the host's window is fine; closing it is not.

  There are three ways to get your friends in:

  1) The claude.ai link (easiest)
     The hosted copy of the game lives at a private claude.ai link. Open it, press
     "Share" on that page and invite your friends by email. They sign in to claude.ai
     (a free account works) and open the same link.
     In the lobby, press "Copy invite link" and send it: opening it drops them straight
     onto the join screen with your code filled in. Open lobbies also show up in a list.
     Note: claude.ai only lets signed-in, invited people into the live game room.
     Someone opening a public link without an invite cannot join multiplayer.

  2) Your own copy of this folder (no Claude account needed)
     Zip the RicochetArena folder and send it. Each friend unzips it and runs Play.bat.
     Lobbies connect peer-to-peer over the internet, using the free PeerJS matchmaking
     server to find each other. Share your 4-character code.
     Strict networks (some school, office or mobile connections) can block peer-to-peer
     connections. If a friend can't join, try a different network.

  3) Your own website (a link is all anyone needs)
     This folder is a complete static website. Upload it to any static host (for example
     an itch.io HTML game, Netlify Drop or GitHub Pages) and open the site there.
     Multiplayer works peer-to-peer like option 2, and "Copy invite link" gives you a link
     that drops friends straight into your lobby. No accounts are needed to play.


LOBBY SETTINGS (host)
  Arena size .............. Small, Medium, Large or Huge
  Mode .................... Last tank standing (rounds) or Deathmatch (respawn after 3 s)
  Teams ................... Free for all, or Blue vs Red (with optional friendly fire)
  Rounds to win / Kill limit
  Shot delay .............. seconds between shots (0.10 to 2.00)
  Shells in the air ....... how many of your shells can be flying at once (1 to 8)
  Ricochets per shell ..... 0 to 3
  Shell speed ............. Slow, Normal, Fast or Rocket
  Mines per tank .......... 0 to 4
  Tank speed .............. Slow, Normal or Fast
  Opponent markers ........ Off, only in line of sight, or always (through walls)
  Aim line allowed ........ lets players use the dotted aim line
  Incoming-shell warnings . the red arcs that point at shells heading for you
  Bots .................... 0 to 7, plus their skill. Up to 8 tanks in total.


CREDITS (assets are CC0, public domain, unless noted)
  Tank models ............. Quaternius (via poly.pizza)
  Textures and sky ........ Poly Haven (polyhaven.com)
  Sound effects ........... Kenney (kenney.nl)
  Fonts ................... Black Ops One, Rajdhani (SIL Open Font License, Google Fonts)
  3D engine ............... three.js r160 (MIT license, see vendor/three/LICENSE)
  Peer-to-peer networking . PeerJS 1.5.4 (MIT license, see vendor/peerjs/LICENSE)
