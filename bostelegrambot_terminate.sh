ps -ef | grep "bos telegram" | grep -m1 -v grep | awk '{print $2}' | xargs -r echo kill -9 | bash
