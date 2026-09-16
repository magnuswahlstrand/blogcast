---
title: All the ways to do change data capture in Postgres
author: Anthony Accomazzo
published: 2023-09-19
source: https://blog.sequinstream.com/all-the-ways-to-capture-changes-in-postgres/
---

# All the ways to do change data capture in Postgres

We're [Sequin](https://sequinstream.com/?ref=blog.sequinstream.com), a Postgres CDC tool to streams and queues like Kafka, SQS, HTTP endpoints, and more. If your data is in Postgres, you're likely reaching for ways to subscribe to changes. We've looked at all the ways to do this, which we've collected here.

*Last updated: 07/17/2025*

Working with data at rest is where Postgres shines. But what about when you need data in motion? What about when you need to trigger a workflow based on changes to a table? Or you need to stream the data in Postgres to another data store, system, or service in real-time?

**Change data capture** (CDC) is the solution to these challenges. CDC is a method for identifying and capturing changes made to data in a database, then delivering those changes to downstream systems in real-time.

There are a lot of options for capturing changes in Postgres. In this post, I’ll lay them all out. I’ll also give you an idea of which are easy to do, which are more robust, and how to make the right choice for you.

## Listen/Notify

Perhaps the simplest approach is to use Postgres' interprocess communication feature, Listen/Notify. Listen/Notify is an implementation of the publish-subscribe pattern.

With Listen/Notify, a Postgres session (or connection) can "listen" to a particular channel for notifications. Activity in the database or other sessions can "notify" that channel. Whenever a notification is sent to a channel, all sessions listening to that channel receive the notification instantly.

You can see Listen/Notify for yourself by opening two `psql` sessions.

In session 1, you can setup your listener:

```
> listen my_channel;
LISTEN
```

And in session 2, you can publish to that channel with a message:

```
> notify my_channel, 'hey there!';
NOTIFY
> notify my_channel, 'is this thing on?';
NOTIFY
```

While the listener process received the message right away, `psql` won't print the message automatically. To get it to print out the messages it's received so far, you just need to run any query. For example, you can just send an empty query like this:

```
> listen my_channel;
LISTEN
> ;
Asynchronous notification "my_channel" with payload "hey there!" received from server process with PID 80019.
Asynchronous notification "my_channel" with payload "is this thing on?" received from server process with PID 80019.
```

(Naturally, this isn't how the Postgres client library in your preferred programming language will work. Libraries will deliver messages to your subscriber immediately without requiring a query.)

To use Listen/Notify to capture changes, you can set up a trigger. For example, here's an `after` trigger that sends along the payload of the record that changed as JSON via Notify:

```
create or replace function notify_trigger() returns trigger as $$
declare
  payload json;
begin
  payload := json_build_object('table', TG_TABLE_NAME, 'id', NEW.id, 'action', TG_OP);
  perform pg_notify('table_changes', payload::text);
  return new;
end;
$$ language plpgsql;

create trigger my_trigger
after insert or update or delete on my_table
for each row execute function notify_trigger();
```

### Downsides

Listen/Notify is simple and powerful, but has some notable downsides.

First, as a pub-sub mechanism, it has "at most once" delivery semantics. Notifications are transient; a listener needs to be listening to a channel when notifications are published. When a listener subscribes to a channel, it will only receive notifications from that moment forward. This also means that if there are network issues that cause a listening session to disconnect even briefly, it won't receive the notification.

Second, the payload size limit is 8000 bytes. If the message exceeds this size, the `notify` command will fail. [\[1\]](#fn1)

As such, Listen/Notify is solid for basic change detection needs, but you'll probably find it does not serve more sophisticated needs well. However, it can complement other strategies (like "poll the table") nicely.

## Poll the table

The simplest *robust* way to capture changes is to poll the table directly. Here, you need each table to have an `updated_at` column or similar that updates whenever the row updates. (You can use a trigger for this.) A combination of `updated_at` [and `id`](https://blog.sequinstream.com/keyset-cursors-not-offsets-for-postgres-pagination/) serve as your cursor. In this setup, your application logic that polls the table handles storing and maintaining the cursor.

In addition to polling the table, you can use a Notify subscription to inform your application that a record has been inserted or modified. Postgres' notifications are ephemeral, so this should only serve as an optimization on top of polling.

### Downsides

This approach has three downsides.

The first is that you can't detect when a row is deleted. There's no way to "see" the missing row in the table.

One remediation is to have a Postgres trigger fire on deletes, and store the `id` (and whatever other columns you want) in a separate table: e.g. `deleted_contacts`. Then, your application can poll that table to discover deletes instead.

The second downside is that you don't get diffs. You know this record was updated since you last polled the table, but you don't know *what* was updated on the record.

The third downside is that Postgres datetimes and sequences [can commit out-of-order](https://blog.sequinstream.com/postgres-sequences-can-commit-out-of-order/). This can lead to race conditions. While you're reading a block of rows `> updated_at`, there might be a row that's in the middle of committing for that block that you miss.

Maybe deletes aren't a big deal for your use case, you don't care about diffs, and missing records every once in a while is not that big of a deal. If so, polling the table is a reasonable and simple solution for tracking changes.

## Audit table

Also called the "outbox pattern".

In this approach, you set up a separate table for logging changes, e.g. `changelog`. That table contains columns related to the record's modification, such as:

-   `action`: Was this an `insert`, `update`, or `delete`?
-   `old`: A jsonb of the record before the mutation. Blank for inserts.
-   `values`: A jsonb of the change fields. Blank for deletes.
-   `inserted_at`: Time the change occurred.

To set this up, you need to create a trigger function that inserts into this table every time a change occurs. Then, you need to create triggers on all the tables you care about to invoke that trigger function.

Here's an example of what that trigger function might look like:

```
create or replace function changelog_trigger() returns trigger as $$
declare
  action text;
  table_name text;
  transaction_id bigint;
  timestamp timestamp;
  old_data jsonb;
  new_data jsonb;
begin
  action := lower(TG_OP::text);
  table_name := TG_TABLE_NAME::text;
  transaction_id := txid_current();
  timestamp := current_timestamp;

  if TG_OP = 'DELETE' then
    old_data := to_jsonb(OLD.*);
  elseif TG_OP = 'INSERT' then
    new_data := to_jsonb(NEW.*);
  elseif TG_OP = 'UPDATE' then
    old_data := to_jsonb(OLD.*);
    new_data := to_jsonb(NEW.*);
  end if;

  insert into changelog (action, table_name, transaction_id, timestamp, old_data, new_data) 
  values (action, table_name, transaction_id, timestamp, old_data, new_data);

  return null;
end;
$$ language plpgsql;
```

After setting up a way to capture changes, you need to figure out how to consume them.

There's a lot of different ways you can do this. One way is to treat the `changelog` as a queue. Your application workers can pull changes from this table. You'll probably want to ensure that changes are processed ~exactly once. You can use the `for update skip locked` feature in Postgres to do this. For example, your workers can open a transaction and grab a chunk of `changelog` entries:

```
begin;

select * 
from changelog 
order by timestamp 
limit 100 
for update skip locked;
```

Now, other workers running that query will not receive this "locked" block of rows. After your worker processes the records, it can delete them:

```
delete from changelog 
where id in (list_of_processed_record_ids);

commit;
```

### Downsides

This path is a choose-your-own-adventure that will require different strategies to scale depending on your needs.

Audit tables result in **write amplification**: a single write in one table results in many writes to the audit table. Typically at least three: the initial insert into the audit table, then the update and delete as the record is processed.

You also need to design the process for fanning-out to workers according to your application. The trigger function and table design I've outlined might work to start. But you'd likely need to make tweaks before deploying at scale in production. [\[2\]](#fn2)

Finally, this solution doesn't have any good ways to manage back-pressure. The audit table will continue to fill, regardless if workers are successfully processing rows.

## Foreign data wrappers

Foreign data wrappers (FDWs) are a Postgres feature that allow you to both read from and write to external data sources from your Postgres database.

The most notable and widely supported extension built on FDWs is `postgres_fdw`. With `postgres_fdw`, you can connect two Postgres databases and create something like a [view](https://www.postgresql.org/docs/current/sql-createview.html?ref=blog.sequinstream.com) in one Postgres database that references a table in another Postgres database. Under the hood, you're turning one Postgres database into a client and the other into a server. When you make queries against foreign tables, the client database sends the queries to the server database via Postgres' [wire protocol](https://www.postgresql.org/docs/current/protocol-flow.html?ref=blog.sequinstream.com).

Using FDWs to capture changes is an unusual strategy. I wouldn't recommend it outside very specific situations.

One situation where FDWs could make sense is if you're capturing changes in one Postgres database in order to write them to another Postgres database. Perhaps you use one database for accounting and another for your application. You can skip the intermediary change capture steps and use `postgres_fdw` to go from database to database.

Here's an example trigger that ensures the status for a given account (identified by `email`) is in-sync across two databases. This assumes the foreign table has already been declared as `foreign_app_database`:

```
create or replace function cancel_subscription()
  returns trigger as $$
declare
  account_status text;
begin
  if (new.status = 'cancelled' or new.status = 'suspended') then
    account_status := 'cancelled';

    update foreign_app_database.account
    set status = account_status
    where email = new.email;
  end if;

  return new;
end;
$$ language plpgsql;
```

In addition to `postgres_fdw`, you can create and load your own foreign data wrappers into your Postgres database.

That means you could create a foreign data wrapper that posts changes to an internal API. Unlike the other change detection strategies in this list, because you'd write to the API inside your commit, your API would have the ability to reject the change and roll back the commit.

### Downsides

Foreign data wrappers are a fun and powerful Postgres feature. But they'll rarely be your best option for capturing changes. And while writing your own foreign data wrapper from scratch [has gotten easier](https://github.com/supabase/wrappers?ref=blog.sequinstream.com), writing your own FDW is probably the biggest lift in this list for capturing changes.

## Direct logical replication

Because replication is a first-class problem for databases, Postgres has a couple of protocols for this. One is **logical replication**. Logical replication is built on top of Postgres' write-ahead-log (WAL). Every insert, update, and delete operation in the database is tracked and streamed to subscribers.

You first create a replication slot on the primary, like this:

```
select * from
pg_create_logical_replication_slot('<your_slot_name>', '<output_plugin>');
```

`output_plugin` is a parameter which specifies which plugin Postgres should use to decode WAL changes. Postgres comes with a few built-in plugins. `pgoutput` is the default. It formats the output in the binary expected by client servers. `test_decoding` is a simple output plugin that provides human-readable output of the changes to the WAL.

The most popular output plugin not built-in to Postgres is `wal2json`. It does what it says on the tin. JSON is an easier starting point for your application to work with than Postgres' binary format.

After creating your replication slot, you can start it and consume from it. Working with replication slots uses a different part of the Postgres protocol than standard queries. But many client libraries have functions that help you work with replication slots.

For example, this is how you consume WAL messages in the `psycopg2` library:

```
cursor.start_replication(slot_name='your_slot_name', decode=True)
cursor.consume_stream(lambda msg: acknowledge_to_server(cursor, msg))

def acknowledge_to_server(cursor, msg):
    # Process the message (msg) here
    # ...
    # Acknowledge the message
    cursor.send_feedback(flush_lsn=msg.wal_end)
```

Note that the client is responsible for ack'ing WAL messages that it has received. So the replication slot behaves sort of like Kafka, with an offset.

### Downsides

Logical replication is a robust solution. It was built for change data capture.

But logical replication is complicated. Replication slots and the replication protocol are less familiar to most developers than the "standard" parts (i.e. tables and queries). Specific strategies are required to ensure that you don't miss messages during restarts or that your system is able to keep up with a high volume of messages coming from Postgres.

## Sequin

We felt there was a gap here, which is why we built [Sequin](https://github.com/sequinstream/sequin?ref=blog.sequinstream.com).

Logical replication is powerful and was designed to stream messages out of Postgres. But as a low-level protocol, it's not easy to work with directly.

Sequin is a change data capture tool that streams Postgres changes and rows to queues (SQS), streams (Kafka), search indexes (Elasticsearch), caches (Redis), HTTP endpoints, and more.

Sequin uses Postgres' logical replication under the hood, but abstracts away all the complexity. This means it's able to capture every insert, update, and delete. For updates and deletes, Sequin captures both the `new` and `old` values of row.

### When to consider Sequin

-   You need real-time CDC
-   You want to stream directly to destinations like SQS or webhooks without intermediary systems
-   You want power features like backfilling historical data and filtering changes with SQL where clauses
-   You want a simpler alternative to managing replication slots directly
-   You need exactly-once processing guarantees

### Downsides

Sequin is a third-party tool that runs alongside your Postgres database instead of inside it. Unlike an extension, this means Sequin has broad compatability with any Postgres database. But it is one more piece of infrastructure you need to stand up (unless you're using [Sequin Cloud](https://sequinstream.com/?ref=blog.sequinstream.com).

## Conclusion

There are lots of options for capturing changes in Postgres. Depending on your use case, some options are clearly better than others. In sum:

**Starting out**

Listen/Notify is great for non-critical event capture, prototyping, or optimizing polling. Polling for changes is a fine, straightforward solution for simple use cases.

**Starting to get serious**

An audit table can be a great middle-of-the-road solution. You can capture `new` and `old` payloads of rows. And, if you build it correctly, you can get an exactly-once processing system.

You'll face trouble scaling this solution (write amplification, no back-pressure). And if you get something wrong in your manual setup, you may drop messages.

**Scaling**

Logical replication is your best bet for a robust solution. But you'll want to use a tool like Sequin instead of pulling from the slot directly.

**Just for fun**

Foreign data wrappers are neat, but solve a need you’re unlikely to have.

* * *

1.  Note the payload size includes the channel name, which like all Postgres identifiers can be up to 64 bytes in size. [↩︎](#fnref1)
    
2.  One example issue that comes to mind: should there be a timeout for how long workers can have changes checked out? [↩︎](#fnref2)
