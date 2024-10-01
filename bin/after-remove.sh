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

RDIR="/opt/fwcloud"

# If /opt/fwcloud dir is empty, remove it and remove fwcloud user and group.
if [ -d "$RDIR" ]; then
    rm -rf "${RDIR}/ui"
    rm -rf "${RDIR}/websrv"

  if [ ! "$(ls -A $RDIR)" ]; then # Root directory is empty.
    rmdir "$RDIR"

    userdel fwcloud 2>/dev/null
    groupdel fwcloud 2>/dev/null
  fi
fi

# This is necessary because with FPM we don't have yet an --rpm-systemd option like the --deb-systemd option.
SRVFILE="/lib/systemd/system/fwcloud-websrv.service"
if [ -f "$SRVFILE" ]; then
  rm -f $SRVFILE
fi

# Some Linux distributions have SELinux enabled.
if command -v getenforce >/dev/null 2>&1; then
  if [ $(getenforce) = "Enforcing" ]; then
    semodule -r fwcloud-websrv
  fi
fi

exit 0
