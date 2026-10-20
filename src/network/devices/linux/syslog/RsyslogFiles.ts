
export const RSYSLOG_CONF_PATH = '/etc/rsyslog.conf';
export const RSYSLOG_D_DIR = '/etc/rsyslog.d';

export const RSYSLOG_CONF_DEBIAN = `#  /etc/rsyslog.conf	Configuration file for rsyslog.
#
#			For more information install rsyslog-doc and see
#			/usr/share/doc/rsyslog-doc/html/configuration/index.html

#################
#### MODULES ####
#################

module(load="imuxsock")	# provides support for local system logging
module(load="imklog")	# provides kernel logging support

# provides UDP syslog reception
#module(load="imudp")
#input(type="imudp" port="514")

# provides TCP syslog reception
#module(load="imtcp")
#input(type="imtcp" port="514")

###########################
#### GLOBAL DIRECTIVES ####
###########################

#
# Use traditional timestamp format.
# To enable high precision timestamps, comment out the following line.
#
$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat

# Filter duplicated messages
$RepeatedMsgReduction on

#
# Set the default permissions for all log files.
#
$FileOwner root
$FileGroup adm
$FileCreateMode 0640
$DirCreateMode 0755
$Umask 0022

#
# Where to place spool and state files
#
$WorkDirectory /var/spool/rsyslog

#
# Include all config files in /etc/rsyslog.d/
#
$IncludeConfig /etc/rsyslog.d/*.conf
`;

export const RSYSLOG_50_DEFAULT = `#  Default rules for rsyslog.
#
#			For more information see rsyslog.conf(5) and /etc/rsyslog.conf

#
# First some standard log files.  Log by facility.
#
auth,authpriv.*			/var/log/auth.log
*.*;auth,authpriv.none		-/var/log/syslog
#cron.*				/var/log/cron.log
#daemon.*			-/var/log/daemon.log
kern.*				-/var/log/kern.log
#lpr.*				-/var/log/lpr.log
mail.*				-/var/log/mail.log
user.*				-/var/log/user.log

#
# Logging for the mail system.  Split it up so that
# it is easy to write scripts to parse these files.
#
#mail.info			-/var/log/mail.info
#mail.warn			-/var/log/mail.warn
mail.err			/var/log/mail.err

#
# Some "catch-all" log files.
#
#*.=debug;\\
#	auth,authpriv.none;\\
#	news.none;mail.none	-/var/log/debug
#*.=info;*.=notice;*.=warn;\\
#	auth,authpriv.none;\\
#	cron,daemon.none;\\
#	mail,news.none		-/var/log/messages

#
# Emergencies are sent to everybody logged in.
#
*.emerg				:omusrmsg:*

#
# I like to have messages displayed on the console, but only on a virtual
# console I usually leave idle.
#
#daemon,mail.*;\\
#	news.=crit;news.=err;news.=notice;\\
#	*.=debug;*.=info;\\
#	*.=notice;*.=warn	/dev/tty8
`;

export const RSYSLOG_LOGROTATE_PATH = '/etc/logrotate.d/rsyslog';

export const RSYSLOG_LOGROTATE_DEBIAN = `/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
{
	rotate 4
	weekly
	missingok
	notifempty
	compress
	delaycompress
	sharedscripts
	postrotate
		/usr/lib/rsyslog/rsyslog-rotate
	endscript
}
`;

export const RSYSLOG_ROTATE_PATH = '/usr/lib/rsyslog/rsyslog-rotate';

export const RSYSLOG_ROTATE_DEBIAN = `#!/bin/sh

/bin/systemctl kill -s HUP rsyslog.service
`;

export const RSYSLOG_SEEDED_FILES: ReadonlyArray<readonly [string, string]> = [
  [RSYSLOG_CONF_PATH, RSYSLOG_CONF_DEBIAN],
  [`${RSYSLOG_D_DIR}/50-default.conf`, RSYSLOG_50_DEFAULT],
  [RSYSLOG_LOGROTATE_PATH, RSYSLOG_LOGROTATE_DEBIAN],
];
