# mybosbotexample

just meant as an example of how wrapping of bos (balanceofsatoshis) can be done in node

this does everything through bos by wrapping the js functions bos uses to act on terminal commands, bos wasn't made for calling these functions directly from other projects (yet) so compatibility can easily change and should be just used as an example

this is not ready for anyone to use and was just for experimentation I was doing, it's nowhere close to a working project

`bos.js` is where I place bos function wrappers and then call them from messy experiments I'm testing out in `index.js`

DO NOT USE AS IS

DO NOT USE AS IS

DO NOT USE AS IS

assumes bos is installed globally and "bos" commands work from anywhere so then just have to run

```
npm start
```

which will do `npm link balanceofsatoshis && node index.js`

it will link global installation that already exists to the project so it's possible to use it w/o installing new one in node_modules

there's 0 package dependencies except for this link

I stop it with ctrl-c

