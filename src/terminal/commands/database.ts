/**
 * Database Commands - SQL client commands for various databases
 */

import { CommandRegistry } from './index';
import { createSQLPlusSession, executeSQLPlus, getSQLPlusPrompt, SQLPlusSession } from '../sql/oracle/sqlplus';
import { createPsqlSession, executePsql, getPsqlPrompt, PsqlSession } from '../sql/postgres/psql';

// Store SQL*Plus sessions for interactive mode
const sqlplusSessions = new Map<string, SQLPlusSession>();

// Store psql sessions for interactive mode
const psqlSessions = new Map<string, PsqlSession>();

export const databaseCommands: CommandRegistry = {
  /**
   * Oracle SQL*Plus command
   */
  sqlplus: (args, state, fs, pm) => {
    // Check if oracle is installed
    const oracleInstalled = pm.isInstalled('oracle-xe-21c') ||
                            pm.isInstalled('oracle-sqlplus') ||
                            pm.isInstalled('oracle-instantclient');

    if (!oracleInstalled) {
      return {
        output: '',
        error: 'sqlplus: command not found\nHint: Install oracle-xe-21c or oracle-sqlplus with: apt install oracle-xe-21c',
        exitCode: 127
      };
    }

    // Handle version
    if (args[0] === '-v' || args[0] === '-V' || args[0] === '--version') {
      return {
        output: `SQL*Plus: Release 21.0.0.0.0 - Production
Version 21.9.0.0.0`,
        exitCode: 0
      };
    }

    // Handle help
    if (args[0] === '-h' || args[0] === '-?' || args[0] === '--help') {
      return {
        output: `
SQL*Plus: Release 21.0.0.0.0 - Production

Usage 1: sqlplus -H | -V

    -H             Displays the SQL*Plus version and the
                   usage help.
    -V             Displays the SQL*Plus version.

Usage 2: sqlplus [ [options] [logon|/nolog] [start] ]

  where <options> ::= [-C <version>] [-L] [-M "<options>"] [-NOLOGINTIME]
                      [-R <level>] [-S]
        <logon>   ::= <username>[/<password>][@<connect_identifier>]
        <start>   ::= @<URI>|<filename>[.<ext>] [<parameter> ...]

  -C <version>     Sets the compatibility of affected commands to the
                   version specified by <version>.
  -L               Attempts to log on just once
  -M "<options>"   Sets automatic HTML markup of output
  -R <level>       Sets restricted mode
  -S               Sets silent mode

SQL*Plus simulation - type 'help' for more information.
`,
        exitCode: 0
      };
    }

    // Parse connection string if provided
    let username = 'SYSTEM';
    let password = 'oracle';
    let database = 'ORCL';

    if (args.length > 0 && args[0] !== '/nolog') {
      const connMatch = args[0].match(/^(\w+)(?:\/(\w+))?(?:@(\w+))?$/);
      if (connMatch) {
        username = connMatch[1].toUpperCase();
        password = connMatch[2] || 'oracle';
        database = connMatch[3] || 'ORCL';
      }
    }

    // Enter interactive SQL*Plus mode
    const banner = `
SQL*Plus: Release 21.0.0.0.0 - Production on ${new Date().toDateString()}
Version 21.9.0.0.0

Copyright (c) 1982, 2022, Oracle.  All rights reserved.

${args[0] === '/nolog' ? '' : `Connected to:
Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production
Version 19.3.0.0.0
`}`;

    return {
      output: banner,
      exitCode: 0,
      enterSQLPlusMode: true,
      sqlplusConfig: { username, database, nolog: args[0] === '/nolog' }
    } as any;
  },

  /**
   * Internal SQL*Plus execution (called from Terminal component)
   */
  __sqlplusExec: (args, state) => {
    const sessionId = state.currentUser;
    let session = sqlplusSessions.get(sessionId);

    if (!session) {
      session = createSQLPlusSession();
      sqlplusSessions.set(sessionId, session);
    }

    const input = args.join(' ');
    const result = executeSQLPlus(session, input);

    if (result.exit) {
      sqlplusSessions.delete(sessionId);
      return {
        output: result.output,
        exitCode: 0,
        exitSQLPlusMode: true
      } as any;
    }

    let output = result.output;
    if (result.error) {
      output += (output ? '\n' : '') + result.error;
    }
    if (result.feedback) {
      output += (output ? '\n' : '') + result.feedback;
    }

    return {
      output,
      exitCode: result.error ? 1 : 0,
      sqlplusPrompt: getSQLPlusPrompt(session)
    } as any;
  },

  /**
   * PostgreSQL client
   */
  psql: (args, state, fs, pm) => {
    const pgInstalled = pm.isInstalled('postgresql-14') || pm.isInstalled('postgresql-client-14') || pm.isInstalled('postgresql');

    if (!pgInstalled) {
      return {
        output: '',
        error: 'psql: command not found\nHint: Install postgresql-client-14 with: apt install postgresql-client-14',
        exitCode: 127
      };
    }

    if (args[0] === '--version' || args[0] === '-V') {
      return {
        output: 'psql (PostgreSQL) 14.7 (Ubuntu 14.7-0ubuntu0.22.04.1)',
        exitCode: 0
      };
    }

    if (args[0] === '--help' || args[0] === '-?') {
      return {
        output: `psql is the PostgreSQL interactive terminal.

Usage:
  psql [OPTION]... [DBNAME [USERNAME]]

General options:
  -c, --command=COMMAND    run only single command (SQL or internal) and exit
  -d, --dbname=DBNAME      database name to connect to
  -f, --file=FILENAME      execute commands from file, then exit
  -l, --list               list available databases, then exit
  -V, --version            output version information, then exit
  -?, --help               show this help, then exit

Connection options:
  -h, --host=HOSTNAME      database server host
  -p, --port=PORT          database server port
  -U, --username=USERNAME  database user name
  -W, --password           force password prompt

For more information, type "\\?" (for internal commands) or "\\h" (for SQL
commands) from within psql.`,
        exitCode: 0
      };
    }

    // Parse arguments
    let dbname = 'postgres';
    let username = 'postgres';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-d' || arg === '--dbname') {
        dbname = args[++i] || dbname;
      } else if (arg.startsWith('-d')) {
        dbname = arg.slice(2);
      } else if (arg.startsWith('--dbname=')) {
        dbname = arg.slice(9);
      } else if (arg === '-U' || arg === '--username') {
        username = args[++i] || username;
      } else if (arg.startsWith('-U')) {
        username = arg.slice(2);
      } else if (arg.startsWith('--username=')) {
        username = arg.slice(11);
      } else if (!arg.startsWith('-') && i === args.length - 1) {
        // Last positional argument is dbname
        dbname = arg;
      }
    }

    // Enter interactive psql mode
    const banner = `psql (14.7 (Ubuntu 14.7-0ubuntu0.22.04.1))
Type "help" for help.
`;

    return {
      output: banner,
      exitCode: 0,
      enterPsqlMode: true,
      psqlConfig: { dbname, username }
    } as any;
  },

  /**
   * MySQL client
   */
  mysql: (args, state, fs, pm) => {
    const mysqlInstalled = pm.isInstalled('mysql-server') || pm.isInstalled('mysql-server-8.0') || pm.isInstalled('mysql-client-8.0');

    if (!mysqlInstalled) {
      return {
        output: '',
        error: 'mysql: command not found\nHint: Install mysql-client-8.0 with: apt install mysql-client-8.0',
        exitCode: 127
      };
    }

    if (args[0] === '--version' || args[0] === '-V') {
      return {
        output: 'mysql  Ver 8.0.32-0ubuntu0.22.04.2 for Linux on x86_64 ((Ubuntu))',
        exitCode: 0
      };
    }

    if (args[0] === '--help' || args[0] === '-?') {
      return {
        output: `mysql  Ver 8.0.32-0ubuntu0.22.04.2 for Linux on x86_64 ((Ubuntu))
Copyright (c) 2000, 2023, Oracle and/or its affiliates.

Usage: mysql [OPTIONS] [database]

  -?, --help          Display this help and exit.
  -V, --version       Output version information and exit.
  -u, --user=name     User for login if not current user.
  -p, --password[=name]  Password to use when connecting to server.
  -h, --host=name     Connect to host.
  -P, --port=#        Port number to use for connection.
  -D, --database=name Database to use.

MySQL simulation - full implementation coming soon.`,
        exitCode: 0
      };
    }

    return {
      output: `Welcome to the MySQL monitor.  Commands end with ; or \\g.
Your MySQL connection id is 8
Server version: 8.0.32-0ubuntu0.22.04.2 (Ubuntu)

Type 'help;' or '\\h' for help. Type '\\c' to clear the current input statement.

MySQL simulation - full implementation coming in a future update.`,
      exitCode: 0,
      enterMysqlMode: true
    } as any;
  },

  /**
   * SQLite3 client
   */
  sqlite3: (args, state, fs, pm) => {
    const sqliteInstalled = pm.isInstalled('sqlite3');

    if (!sqliteInstalled) {
      return {
        output: '',
        error: 'sqlite3: command not found\nHint: Install sqlite3 with: apt install sqlite3',
        exitCode: 127
      };
    }

    if (args[0] === '--version' || args[0] === '-version') {
      return {
        output: '3.37.2 2022-01-06 13:25:41 872ba256cbf61d9290b571c0e6d82a20c224ca3ad82971edc46b29818d5dalt1',
        exitCode: 0
      };
    }

    if (args[0] === '-help' || args[0] === '--help') {
      return {
        output: `Usage: sqlite3 [OPTIONS] FILENAME [SQL]
FILENAME is the name of an SQLite database. A new database is created
if the file does not previously exist.
OPTIONS include:
   -help           show this message
   -version        show SQLite version

SQLite simulation - full implementation coming soon.`,
        exitCode: 0
      };
    }

    return {
      output: `SQLite version 3.37.2 2022-01-06 13:25:41
Enter ".help" for usage hints.
Connected to a transient in-memory database.
Use ".open FILENAME" to reopen on a persistent database.

SQLite simulation - full implementation coming in a future update.`,
      exitCode: 0,
      enterSqliteMode: true
    } as any;
  },

  /**
   * Redis CLI
   */
  'redis-cli': (args, state, fs, pm) => {
    const redisInstalled = pm.isInstalled('redis-server');

    if (!redisInstalled) {
      return {
        output: '',
        error: 'redis-cli: command not found\nHint: Install redis-server with: apt install redis-server',
        exitCode: 127
      };
    }

    if (args[0] === '--version' || args[0] === '-v') {
      return {
        output: 'redis-cli 6.0.16',
        exitCode: 0
      };
    }

    return {
      output: `127.0.0.1:6379> Redis simulation - full implementation coming soon.
Type 'quit' to exit.`,
      exitCode: 0,
      enterRedisMode: true
    } as any;
  },

  /**
   * MongoDB shell
   */
  mongosh: (args, state, fs, pm) => {
    const mongoInstalled = pm.isInstalled('mongodb-org');

    if (!mongoInstalled) {
      return {
        output: '',
        error: 'mongosh: command not found\nHint: Install mongodb-org with: apt install mongodb-org',
        exitCode: 127
      };
    }

    if (args[0] === '--version') {
      return {
        output: '1.8.0',
        exitCode: 0
      };
    }

    return {
      output: `Current Mongosh Log ID: 6433ea7b2c5b5c2b2c2b2c2b
Connecting to:          mongodb://127.0.0.1:27017/
Using MongoDB:          6.0.5
Using Mongosh:          1.8.0

MongoDB simulation - full implementation coming soon.
Type 'exit' to quit.`,
      exitCode: 0,
      enterMongoMode: true
    } as any;
  }
};

// Export SQL*Plus session management for use by Terminal
export function getSQLPlusSession(sessionId: string): SQLPlusSession | undefined {
  return sqlplusSessions.get(sessionId);
}

export function createOrGetSQLPlusSession(sessionId: string): SQLPlusSession {
  let session = sqlplusSessions.get(sessionId);
  if (!session) {
    session = createSQLPlusSession();
    sqlplusSessions.set(sessionId, session);
  }
  return session;
}

export function deleteSQLPlusSession(sessionId: string): void {
  sqlplusSessions.delete(sessionId);
}

// Export psql session management for use by Terminal
export function getPsqlSession(sessionId: string): PsqlSession | undefined {
  return psqlSessions.get(sessionId);
}

export function createOrGetPsqlSession(sessionId: string): PsqlSession {
  let session = psqlSessions.get(sessionId);
  if (!session) {
    session = createPsqlSession();
    psqlSessions.set(sessionId, session);
  }
  return session;
}

export function deletePsqlSession(sessionId: string): void {
  psqlSessions.delete(sessionId);
}

// Re-export psql functions for Terminal
export { executePsql, getPsqlPrompt } from '../sql/postgres/psql';
