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
NODE=`which node`
NPM=`which node`

if [ -z "$NODE" ]; then
  echo "Node must be installed."
  exit 1
fi

if [ -z "$NPM" ]; then
  echo "Npm must be installed."
  exit 1
fi


# Create the fwcloud user and group.
groupadd fwcloud 2>/dev/null
useradd fwcloud -g fwcloud -m -c "SOLTECSIS - FWCloud.net" -s `which bash` 2>/dev/null

exit 0
