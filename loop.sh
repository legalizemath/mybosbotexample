# loop whatever 1st parameter is submitted as bash command
# can run with . ./loop.sh "npm run start"
echo "$BASH_SOURCE $1"
while true; do
  $1
  echo "'$1' exited with code $?.  Respawning in 5 sec..." >&2
  sleep 5
done
