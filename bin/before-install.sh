#!/bin/sh
#############################################
##                                         ##
##  FWCloud.net                            ##
##  https://fwcloud.net                    ##
##  info@fwcloud.net                       ##
##                                         ##
##  Developed by SOLTECSIS, S.L.           ##
##  https://soltecsis.com                  ##
##  info@soltecsis.com                     ##
##                                         ##
#############################################

# Verify that Node.js and NPM are installed.

# Create the fwcloud user and group.
if [ "$DIST" = "FreeBSD" ]; then
  PW="pw"
else
  PW=""
fi
$PW groupadd fwcloud 2>/dev/null
$PW useradd fwcloud -g fwcloud -m -c "SOLTECSIS - FWCloud.net" -s `which bash` 2>/dev/null

exit 0
