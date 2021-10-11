# mybosbotexample

just meant as an example of how wrapping of bos (balanceofsatoshis) can be done in node

this does everything through bos by wrapping the js functions bos uses to act on terminal commands, bos wasn't made for calling these functions directly from other projects (yet) so compatibility can easily change and should be just used as an example

this is not ready for anyone to use and was just for experimentation I was doing, there's probably errors all over this thing, it's nowhere close to a working project

`bos.js` is where I place bos function wrappers and then call them from messy experiments I'm testing out in some script file `_____.js` like `visualize.js`

DO NOT USE AS IS

DO NOT USE AS IS

DO NOT USE AS IS

assumes bos is installed globally and "bos" commands work from anywhere so then just have to run

I used these installation guides so I can run bos commands like `bos utxos` from terminal, using nodejs v14 like in instructions

* https://gist.github.com/alexbosworth/8fad3d51f9e1ff67995713edf2d20126
* https://github.com/alexbosworth/balanceofsatoshis#install
* https://github.com/alexbosworth/balanceofsatoshis#saved-nodes

Then I created package.json with `{ "type": "module" }` for imports to work, then I place wrapper bos.js and somescript.js file into same folder

and I run somescript.js via

```bash
npm link balanceofsatoshis && node somescript
```

npm link will link global installation that already exists to the project so it's possible to use it w/o installing new one in node_modules & setting up auth again

there's 0 package dependencies except for linking balanceofsatoshis that is already installed and using nodejs that you already need to use balanceofsatoshis

I stop it with ctrl+c

#Bitcoin, not 💩coin

