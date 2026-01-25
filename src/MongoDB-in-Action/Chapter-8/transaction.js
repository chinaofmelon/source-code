/**
 * Multi-document transaction using MongoDB Node.js Driver with Callback API
 *
 * This script demonstrates how to perform a transactional update on multiple collections using
 * the MongoDB Node.js driver. It uses `session.withTransaction()` for automatic handling of
 * commit/abort and retries. The transaction updates the account and related customers, then inserts
 * a new transaction record. All operations happen inside a single ACID-compliant transaction.
 *
 * Usage:
 *   node transaction.js <account_id>
 * Example:
 *   node transaction.js 714727
 */

const { MongoClient } = require('mongodb')

// Replace with your actual connection string
const uri = "your_mongodb_connection_string"

async function run(accountId) {
  const client = new MongoClient(uri)

  try {
    await client.connect()
    const session = client.startSession()

    const transactionOptions = {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    }

    await session.withTransaction(async () => {
      const accounts = client.db('sample_analytics').collection('accounts')
      const customers = client.db('sample_analytics').collection('customers')
      const transactions = client.db('sample_analytics').collection('transactions')
      const currentDate = new Date()

      const account = await accounts.findOne(
        { account_id: parseInt(accountId) },
        { session }
      )
      if (!account) throw new Error('Account not found')

      const accountsUpdateResult = await accounts.updateOne(
        { account_id: parseInt(accountId) },
        {
          $set: { limit: 12000, last_transaction_date: currentDate },
          $inc: { transaction_count: 1 }
        },
        { session }
      )

      const customersUpdateResult = await customers.updateMany(
        { accounts: { $in: [parseInt(accountId)] } },
        {
          $inc: { transaction_count: 1 },
          $set: { last_transaction_date: currentDate }
        },
        { session }
      )

      const transactionsInsertResult = await transactions.insertOne(
        {
          account_id: parseInt(accountId),
          transaction_count: account.transaction_count + 1,
          bucket_start_date: currentDate,
          bucket_end_date: currentDate,
          transactions: [
            {
              date: currentDate,
              amount: 1500,
              transaction_code: 'buy',
              symbol: 'amzn',
              price: '125.00',
              total: '187500.00'
            }
          ]
        },
        { session }
      )

      console.log("Transaction committed.")
      console.log("Accounts updated:", accountsUpdateResult.modifiedCount)
      console.log("Customers updated:", customersUpdateResult.modifiedCount)
      console.log("New transaction inserted:", transactionsInsertResult.insertedId)

    }, transactionOptions)

    session.endSession()
  } catch (error) {
    console.error("Transaction aborted due to error:", error)
  } finally {
    await client.close()
  }
}

// Get accountId from command line arguments
const accountId = process.argv[2]
if (!accountId) {
  console.error("Please provide an account ID as an argument.")
  process.exit(1)
}

run(accountId).catch(console.dir)
