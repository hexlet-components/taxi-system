import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

public class TripPublisher {
    public static void main(String[] args) throws Exception {
        var settings = new Properties();
        settings.put("bootstrap.servers", "kafka:9092");
        settings.put("key.serializer", StringSerializer.class.getName());
        settings.put("value.serializer", StringSerializer.class.getName());
        settings.put("acks", "all");
        settings.put("enable.idempotence", "true");
        int limit = args.length > 1 ? Integer.parseInt(args[1]) : Integer.MAX_VALUE;

        try (var producer = new KafkaProducer<String, String>(settings)) {
            var lines = Files.readAllLines(Path.of(args[0]));
            for (String event : lines.subList(0, Math.min(limit, lines.size()))) {
                // Топик опыта содержит одну партицию
                var record = new ProducerRecord<String, String>("trip.completed.demo", event);
                // Ждём приёма Kafka, запись в ClickHouse происходит независимо
                var result = producer.send(record).get();
                System.out.printf("partition=%d offset=%d%n", result.partition(), result.offset());
            }
        }
    }
}
